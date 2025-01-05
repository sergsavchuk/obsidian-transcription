import { TranscriptionSettings, /*SWIFTINK_AUTH_CALLBACK*/ API_BASE, DEFAULT_SETTINGS } from "src/settings";
import { Notice, requestUrl, RequestUrlParam, TFile, Vault, App } from "obsidian";
import { format } from "date-fns";
import { paths, components } from "./types/swiftink";
import { PayloadData, payloadGenerator, preprocessWhisperASRResponse } from "src/utils";
import { StatusBar } from "./status";
import { SupabaseClient } from "@supabase/supabase-js";
import * as tus from "tus-js-client";
import { WhisperASRResponse, WhisperASRSegment } from "./types/whisper-asr";

import { ClientRequest, IncomingMessage } from 'http';

const https = require('https');
const { randomUUID } = require("crypto");

// The language code of the speech in media file.
// See more lang code: https://docs.speechflow.io/#/?id=ap-lang-list
const LANG = "ru";

// The translation result type.
// 1, the default result type, the json format for sentences and words with begin time and end time.
// 2, the json format for the generated subtitles with begin time and end time.
// 3, the srt format for the generated subtitles with begin time and end time.
// 4, the plain text format for transcription results without begin time and end time.
const RESULT_TYPE = 1;

type TranscriptionBackend = (file: TFile) => Promise<string>;

const MAX_TRIES = 100

export class TranscriptionEngine {
    settings: TranscriptionSettings;
    vault: Vault;
    statusBar: StatusBar | null;
    supabase: SupabaseClient;
    app: App;

    transcriptionEngine: TranscriptionBackend;

    transcription_engines: { [key: string]: TranscriptionBackend } = {
        swiftink: this.getTranscriptionSwiftink,
        whisper_asr: this.getTranscriptionWhisperASR,
    };

    constructor(
        settings: TranscriptionSettings,
        vault: Vault,
        statusBar: StatusBar | null,
        supabase: SupabaseClient,
        app: App
    ) {
        this.settings = settings;
        this.vault = vault;
        this.statusBar = statusBar;
        this.supabase = supabase;
        this.app = app;
    }

    segmentsToTimestampedString(
        segments: components["schemas"]["TimestampedTextSegment"][],
        timestampFormat: string,
        interval: number = 0 // in seconds, default is 0 which means no interval adjustment
    ): string {
        let maxDuration = 0;

        // Find the largest timestamp in the segments
        segments.forEach(segment => {
            maxDuration = Math.max(maxDuration, segment.end);
        });

        // Decide format based on maxDuration
        const autoFormat = maxDuration < 3600 ? "mm:ss" : "HH:mm:ss";

        const renderSegments = (segments: components["schemas"]["TimestampedTextSegment"][]) => (
            segments.reduce((transcription: string, segment ) => {
                let start = new Date(segment.start * 1000);
                let end = new Date(segment.end * 1000);
                start = new Date(start.getTime() + start.getTimezoneOffset() * 60000);
                end = new Date(end.getTime() + end.getTimezoneOffset() * 60000);
                const formatToUse = timestampFormat === 'auto' ? autoFormat : timestampFormat;
                const start_formatted = format(start, formatToUse);
                const end_formatted = format(end, formatToUse);
                const segment_string = `${start_formatted} - ${end_formatted}: ${segment.text.trim()}\n`;
                transcription += segment_string;
                return transcription;
            }, ""));

        if (interval > 0) {
            // Group segments based on interval
            const groupedSegments: Record<string, { start: number, end: number, texts: string[] }> = {};
            segments.forEach(segment => {
                // Determine which interval the segment's start time falls into
                const intervalStart = Math.floor(segment.start / interval) * interval;
                if (!groupedSegments[intervalStart]) {
                    groupedSegments[intervalStart] = {
                        start: segment.start,
                        end: segment.end,
                        texts: [segment.text]
                    };
                } else {
                    groupedSegments[intervalStart].end = Math.max(groupedSegments[intervalStart].end, segment.end);
                    groupedSegments[intervalStart].texts.push(segment.text);
                }
            });

            const bucketedSegments = Object.values(groupedSegments).map(group => ({
                start: group.start,
                end: group.end,
                text: group.texts.join("").trim()
            }));
            return renderSegments(bucketedSegments);
        } else {
            // Default behavior: timestamp each segment individually
            return renderSegments(segments);
        }
    }

    async getTranscription(file: TFile): Promise<string> {
        if (this.settings.debug)
            console.log(
                `Transcription engine: ${this.settings.transcriptionEngine}`,
            );
        const start = new Date();
        this.transcriptionEngine =
            this.transcription_engines[this.settings.transcriptionEngine];
        return this.transcriptionEngine(file).then((transcription) => {
            if (this.settings.debug)
                console.log(`Transcription: ${transcription}`);
            if (this.settings.debug)
                console.log(
                    `Transcription took ${new Date().getTime() - start.getTime()
                    } ms`,
                );
            return transcription;
        });
    }

    async getTranscriptionWhisperASR(file: TFile): Promise<string> {

        // Generate API KEY, see: https://docs.speechflow.io/#/?id=generate-api-key
        const apiKeyData = this.settings.whisperASRUrls.split(":");
        const API_KEY_ID = apiKeyData[0];
        const API_KEY_SECRET = apiKeyData[1];

        //Parameter of the remote file
        const createData = `lang=${LANG}&remotePath=${file.name}`;

         let createRequest:ClientRequest;

        console.log('submitting a local file');
        let formData = '';
        const boundary:string = randomUUID().replace(/-/g, "");
        formData += "--" + boundary + "\r\n";
        formData += 'Content-Disposition: form-data; name="file"; filename="' + file.name + '"\r\n';
        formData += "Content-Type: application/octet-stream\r\n\r\n";
        let formDataBuffer:Buffer = Buffer.concat([
            Buffer.from(formData, "utf8"),
            new Uint8Array(await this.vault.readBinary(file)),
            Buffer.from("\r\n--" + boundary + "--\r\n", "utf8"),
        ]);

        createRequest = https.request({
            method: 'POST',
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": formDataBuffer.length,
                'keyId': API_KEY_ID,
                'keySecret': API_KEY_SECRET,
            },
            hostname: 'api.speechflow.io',
            path: '/asr/file/v1/create?lang=' + LANG
        });
        createRequest.write(formDataBuffer)




    const promise = new Promise<string>( (resolve, reject) => {



        createRequest.on('response', (createResponse:IncomingMessage):void => {
            let responseData = '';

            createResponse.on('data', (chunk:string):void => {
                responseData += chunk;
            });

            createResponse.on('end', ():void => {
                const responseJSON:{code: number, taskId: string, msg: string} = JSON.parse(responseData);
                let taskId
                if (responseJSON.code == 10000) {
                    taskId = responseJSON.taskId;
                } else {
                    console.log("create error:");
                    console.log(responseJSON.msg);

                    reject(responseJSON.msg);

                    return ;
                }

                let intervalID: ReturnType<typeof setInterval> = setInterval(() => {
                    const queryRequest:ClientRequest = https.request({
                        method: 'GET',
                        headers: {
                            'keyId': API_KEY_ID,
                            'keySecret': API_KEY_SECRET
                        },
                        hostname: 'api.speechflow.io',
                        path: '/asr/file/v1/query?taskId=' + taskId + '&resultType=' + RESULT_TYPE
                    }, (queryResponse:IncomingMessage):void => {
                        let responseData = '';

                        queryResponse.on('data', (chunk:string):void => {
                            responseData += chunk;
                        });

                        queryResponse.on('end', ():void => {
                            const responseJSON:{ code: number, msg: string} = JSON.parse(responseData);
                            if (responseJSON.code === 11000) {
                                const sentencesJSON = JSON.parse(responseJSON.result);
                                const sentences = sentencesJSON.sentences.map((s) => s.s);
                                const result = sentences.join(' ');
                                console.log('transcription result:');
                                console.log(result);
                                resolve(result);


                                clearInterval(intervalID);
                            } else if (responseJSON.code == 11001) {
                                console.log('waiting');
                            } else {
                                console.log("transcription error:");
                                console.log(responseJSON.msg);

                                reject(responseJSON.msg);

                                clearInterval(intervalID);
                            }
                        });
                    });

                    queryRequest.on('error', (error:Error):void => {
                        console.error(error);

                        reject(error);

                        clearInterval(intervalID);
                    });
                    queryRequest.end();
                }, 3000);
            });
        });

        createRequest.on('error', (error:Error):void => {
            console.error(error);
        });

        createRequest.write(createData);
        createRequest.end();
        });

    return promise;
    }

    async getTranscriptionSwiftink(file: TFile): Promise<string> {
        //const api_base = "https://api.swiftink.io";

        const session = await this.supabase.auth.getSession().then((res) => {
            return res.data;
        });

        if (session == null || session.session == null) {
            //window.open(SWIFTINK_AUTH_CALLBACK, "_blank");
            return Promise.reject(
                "No user session found. Please log in and try again.",
            );
        }

        const token = session.session.access_token;
        const id = session.session.user.id;

        const fileStream = await this.vault.readBinary(file);
        const filename = file.name.replace(/[^a-zA-Z0-9.]+/g, "-");

        // Declare progress notice for uploading
        let uploadProgressNotice: Notice | null = null;

        const uploadPromise = new Promise<tus.Upload>((resolve) => {
            const upload = new tus.Upload(new Blob([fileStream]), {
                endpoint: `https://vcdeqgrsqaexpnogauly.supabase.co/storage/v1/upload/resumable`,
                retryDelays: [0, 3000, 5000, 10000, 20000],
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-upsert": "true",
                },
                uploadDataDuringCreation: true,
                metadata: {
                    bucketName: "swiftink-upload",
                    objectName: `${id}/${filename}`,
                },
                chunkSize: 6 * 1024 * 1024,
                onProgress: (bytesUploaded, bytesTotal) => {
                    const percentage = (
                        (bytesUploaded / bytesTotal) *
                        100
                    ).toFixed(2);

                    // Create a notice message with the progress
                    const noticeMessage = `Uploading ${filename}: ${percentage}%`;

                    // Check if a notice has already been created
                    if (!uploadProgressNotice) {
                        // If not, create a new notice
                        uploadProgressNotice = new Notice(noticeMessage, 80 * 1000);
                    } else {
                        // If the notice exists, update its content
                        uploadProgressNotice.setMessage(noticeMessage);
                        //uploadProgressNotice.hide();
                    }

                    if (this.settings.debug) {
                        console.log(
                            bytesUploaded,
                            bytesTotal,
                            percentage + "%",
                        );
                    }
                },
                onSuccess: () => {
                    if (this.settings.debug) {
                        console.log(
                            `Successfully uploaded ${filename} to Swiftink`,
                        );
                    }

                    // Close the progress notice on successful upload
                    if (uploadProgressNotice) {
                        uploadProgressNotice.hide();
                    }

                    resolve(upload);
                },

            });

            upload.start();
        });

        try {
            await uploadPromise;
            new Notice(`Successfully uploaded ${filename} to Swiftink`);
        } catch (error) {
            if (this.settings.debug) {
                console.log("Failed to upload to Swiftink: ", error);
            }

            return Promise.reject(new Notice(`Failed to upload ${filename} to Swiftink`));
        }

        // Declare progress notice for transcription
        let transcriptionProgressNotice: Notice | null = null;

        const fileUrl = `https://vcdeqgrsqaexpnogauly.supabase.co/storage/v1/object/public/swiftink-upload/${id}/${filename}`;
        const url = `${API_BASE}/transcripts/`;
        const headers = { Authorization: `Bearer ${token}` };
        const body: paths["/transcripts/"]["post"]["requestBody"]["content"]["application/json"] =
        {
            name: filename,
            url: fileUrl,
        };

        if (this.settings.language != "auto")
            body.language = this.settings
                .language as components["schemas"]["CreateTranscriptionRequest"]["language"];

        if (this.settings.debug) console.log(body);

        const options: RequestUrlParam = {
            method: "POST",
            url: url,
            headers: headers,
            body: JSON.stringify(body),
        };

        let transcript_create_res;
        try {
            transcript_create_res = await requestUrl(options);
        } catch (error) {
            if (this.settings.debug)
                console.log("Failed to create transcript: ", error);
            return Promise.reject(error);
        }

        let transcript: components["schemas"]["TranscriptSchema"] =
            transcript_create_res.json;
        if (this.settings.debug) console.log(transcript);

        let completed_statuses = ["transcribed", "complete"];

        if (
            this.settings.embedSummary ||
            this.settings.embedOutline ||
            this.settings.embedKeywords
        ) {
            completed_statuses = ["complete"];
        }

        return new Promise((resolve, reject) => {
            let tries = 0;

            // Function to update the transcription progress notice
            const updateTranscriptionNotice = () => {
                const noticeMessage = `Transcribing ${transcript.name}...`;
                if (!transcriptionProgressNotice) {
                    transcriptionProgressNotice = new Notice(noticeMessage, 80 * 1000);
                } else {
                    transcriptionProgressNotice.setMessage(noticeMessage);

                }
            };

            const poll = setInterval(async () => {
                const options: RequestUrlParam = {
                    method: "GET",
                    url: `${API_BASE}/transcripts/${transcript.id}`,
                    headers: headers,
                };
                const transcript_res = await requestUrl(options);
                transcript = transcript_res.json;
                if (this.settings.debug) console.log(transcript);

                if (
                    transcript.status &&
                    completed_statuses.includes(transcript.status)
                ) {
                    clearInterval(poll);

                    //Close the transcription progress notice on completion
                    if (transcriptionProgressNotice) {
                        transcriptionProgressNotice.hide();
                    }

                    new Notice(
                        `Successfully transcribed ${filename} with Swiftink`,
                    );
                    resolve(this.formatSwiftinkResults(transcript));
                } else if (transcript.status == "failed") {
                    if (this.settings.debug)
                        console.error(
                            "Swiftink failed to transcribe the file"
                        );
                    clearInterval(poll);
                    reject("Swiftink failed to transcribe the file");
                } else if (transcript.status == "validation_failed") {
                    if (this.settings.debug)
                        console.error(
                            "Swiftink has detected an invalid file"
                        );
                    clearInterval(poll);
                    reject("Swiftink has detected an invalid file");
                } else if (tries > MAX_TRIES) {
                    if (this.settings.debug)
                        console.error(
                            "Swiftink took too long to transcribe the file"
                        );
                    clearInterval(poll);
                    reject(
                        "Swiftink took too long to transcribe the file"
                    );
                } else {
                    // Update the transcription progress notice
                    updateTranscriptionNotice();
                }
                tries++;
            }, 3000);
        });
    }

    formatSwiftinkResults(
        transcript: components["schemas"]["TranscriptSchema"]
    ): string {
        let transcript_text = "## Transcript\n";

        if (this.settings.timestamps)
            transcript_text += this.segmentsToTimestampedString(
                transcript.text_segments,
                this.settings.timestampFormat
            );
        else transcript_text += transcript.text ? transcript.text : "";

        if (transcript_text.slice(-1) !== "\n")
            transcript_text += "\n";

        if (
            this.settings.embedSummary &&
            transcript.summary &&
            transcript.summary !==
            "Insufficient information for a summary."
        )
            transcript_text += `## Summary\n${transcript.summary}`;

        if (transcript_text.slice(-1) !== "\n")
            transcript_text += "\n";

        if (
            this.settings.embedOutline &&
            transcript.heading_segments.length > 0
        )
            transcript_text += `## Outline\n${this.segmentsToTimestampedString(
                transcript.heading_segments,
                this.settings.timestampFormat
            )}`;

        if (transcript_text.slice(-1) !== "\n")
            transcript_text += "\n";

        if (
            this.settings.embedKeywords &&
            transcript.keywords.length > 0
        )
            transcript_text += `## Keywords\n${transcript.keywords.join(
                ", "
            )}`;

        if (transcript_text.slice(-1) !== "\n")
            transcript_text += "\n";

        if (this.settings.embedAdditionalFunctionality) {
            transcript_text += `[...](obsidian://swiftink_transcript_functions?id=${transcript.id})`;
        }

        return transcript_text;
    }
}

