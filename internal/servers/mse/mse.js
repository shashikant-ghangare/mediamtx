document.addEventListener('DOMContentLoaded', async () => {
    const videoElement = document.getElementById('mseVideoPlayer');
    const ffmpegStatusElement = document.getElementById('ffmpegStatus');
    const log = (message) => console.log('[MSE Player] ' + message);
    const err = (message) => console.error('[MSE Player] ' + message);
    const updateFFmpegStatus = (status) => {
        if (ffmpegStatusElement) {
            ffmpegStatusElement.style.display = 'block';
            ffmpegStatusElement.textContent = `FFmpeg: ${status}`;
        }
        log(`FFmpeg Status: ${status}`);
    };

    if (!videoElement) {
        err('Video element with ID "mseVideoPlayer" not found!');
        return;
    }

    if (!window.MediaSource) {
        err('MediaSource API is not available in this browser.');
        alert('Your browser does not support MediaSource Extensions, which are required for playback.');
        return;
    }

    log('Initialized');

    let streamPath = window.location.pathname;
    const pathParts = streamPath.split('/');
    let msePathSegment = "";
    const mseIndex = pathParts.indexOf('mse');

    if (mseIndex > 0 && pathParts[mseIndex - 1]) {
        msePathSegment = pathParts[mseIndex - 1];
    } else if (mseIndex > 1 && pathParts[mseIndex - 2]) {
        msePathSegment = pathParts[mseIndex - 2];
    } else {
        const defaultStreamName = 'mystream';
        err(`Could not determine stream path from URL: ${streamPath}. Falling back to default: '${defaultStreamName}'. This may not work if the server endpoint is different.`);
        msePathSegment = defaultStreamName;
    }

    const videoStreamURL = `/mse/${msePathSegment}`;
    log(`Attempting to stream from: ${videoStreamURL}`);

    const mediaSource = new MediaSource();
    videoElement.src = URL.createObjectURL(mediaSource);

    let ffmpeg = null;
    let ffmpegLoaded = false;

    mediaSource.addEventListener('sourceopen', async () => {
        log('MediaSource opened.');
        let mimeCodec = 'video/mp4; codecs="hvc1"'; // Default to H265
        let needsTranscoding = false;

        if (!MediaSource.isTypeSupported(mimeCodec)) {
            err(`H265 codec (${mimeCodec}) is not directly supported by this browser.`);
            log('Attempting to use H264 via client-side transcoding with FFmpeg.wasm.');
            mimeCodec = 'video/mp4; codecs="avc1.42E01E"'; // H264 codec
            needsTranscoding = true;

            if (!MediaSource.isTypeSupported(mimeCodec)) {
                err(`H264 codec (${mimeCodec}) is also not supported. Cannot play video.`);
                alert('Your browser does not support H265 or H264 playback via MediaSource.');
                mediaSource.endOfStream('decode');
                return;
            }
            log('H264 codec is supported. Will proceed with transcoding.');

            if (!ffmpeg) {
                //@ts-ignore
                ffmpeg = new FFmpeg.FFmpeg();
                ffmpeg.on('log', ({ message }) => { // Use FFmpeg's internal log
                    log(`FFmpeg log: ${message}`);
                });
                 updateFFmpegStatus('Loading core...');
                try {
                    // Using a specific version for the core via unpkg
                    // This URL might change or need to be specific to the FFmpeg.wasm version
                    await ffmpeg.load({
                        coreURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js"
                    });
                    ffmpegLoaded = true;
                    updateFFmpegStatus('Core loaded.');
                } catch (e) {
                    err(`Failed to load FFmpeg core: ${e.toString()}`);
                    updateFFmpegStatus('Error loading core.');
                    alert('Failed to load FFmpeg for transcoding. Playback not possible.');
                    mediaSource.endOfStream('network');
                    return;
                }
            } else if (ffmpegLoaded) {
                 updateFFmpegStatus('Core already loaded.');
            } else {
                 updateFFmpegStatus('Loading core (cached instance)...');
                 // Potentially re-attempt load or wait for existing load to complete
            }

        } else {
            log(`H265 codec (${mimeCodec}) is directly supported.`);
        }

        try {
            const sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
            log(`SourceBuffer created with codec: ${mimeCodec}`);
            fetchAndAppendSegment(videoStreamURL, sourceBuffer, mediaSource, needsTranscoding, ffmpeg);
        } catch (e) {
            err(`Exception during MediaSource setup: ${e.toString()}`);
            if (mediaSource.readyState === 'open') {
                mediaSource.endOfStream('network');
            }
        }
    });

    mediaSource.addEventListener('sourceended', () => log('MediaSource ended.'));
    mediaSource.addEventListener('sourceclose', () => log('MediaSource closed.'));
    mediaSource.addEventListener('error', (e) => err(`MediaSource error: ${e.toString()}`));
    videoElement.addEventListener('error', (e) => {
        err(`Video element error: ${videoElement.error?.message} (code: ${videoElement.error?.code})`);
    });

    async function fetchAndAppendSegment(url, sourceBuffer, ms, needsTranscoding, ffmpegInstance) {
        log(`Fetching video data from ${url}`);
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Fetch error: ${response.status} - ${response.statusText}`);
            }
            log('Video data fetch initiated...');
            let data = await response.arrayBuffer();
            log(`Video data (${data.byteLength} bytes) fetched successfully.`);

            if (data.byteLength === 0) {
                log('Received empty data, assuming stream end or no content.');
                if (ms.readyState === 'open' && !sourceBuffer.updating) {
                    ms.endOfStream();
                }
                return;
            }

            if (needsTranscoding) {
                if (!ffmpegInstance || !ffmpegLoaded) {
                    err('FFmpeg is required for transcoding but not loaded/available.');
                    updateFFmpegStatus('Error: FFmpeg not loaded.');
                    if (ms.readyState === 'open') ms.endOfStream('network');
                    return;
                }
                updateFFmpegStatus('Transcoding H265 to H264...');
                const inputFilename = 'input.mp4';
                const outputFilename = 'output.mp4';

                try {
                    await ffmpegInstance.writeFile(inputFilename, new Uint8Array(data));
                    log('Input H265 data written to MEMFS for FFmpeg.');

                    // Using -preset ultrafast and -tune zerolatency for speed.
                    // -movflags frag_keyframe+empty_moov is for fMP4, but since we are doing one big segment,
                    // it might not be strictly necessary but good practice for future segmenting.
                    // However, for a single segment, a standard MP4 output is fine.
                    // Let's simplify for now as the server gives one "segment".
                    await ffmpegInstance.exec(['-i', inputFilename, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', outputFilename]);
                    log('FFmpeg transcoding complete.');
                    updateFFmpegStatus('Transcoding complete.');

                    const transcodedData = await ffmpegInstance.readFile(outputFilename);
                    log(`Transcoded H264 data (${transcodedData.byteLength} bytes) read from MEMFS.`);
                    data = transcodedData.buffer; // data is now the H264 ArrayBuffer

                    // Cleanup MEMFS
                    await ffmpegInstance.deleteFile(inputFilename);
                    await ffmpegInstance.deleteFile(outputFilename);
                    log('Cleaned up MEMFS.');

                } catch (transcodeError) {
                    err(`Error during FFmpeg transcoding: ${transcodeError.toString()}`);
                    updateFFmpegStatus(`Error: Transcoding failed.`);
                    if (ms.readyState === 'open') ms.endOfStream('network');
                    return;
                }
            }

            const appendBuffer = () => {
                try {
                    if (ms.readyState === 'open' && !sourceBuffer.updating) {
                        log('Appending buffer...');
                        sourceBuffer.appendBuffer(data);
                    } else if (ms.readyState !== 'open') {
                        err('MediaSource is not open. Cannot append buffer.');
                    } else {
                         log('SourceBuffer is updating. Queueing append.');
                         // This simple queue might not be robust enough for rapid segments.
                         sourceBuffer.addEventListener('updateend', function onUpdateEnd() {
                            log('SourceBuffer update ended (queued). Appending now.');
                            appendBuffer(); // Retry append
                         }, { once: true });
                    }
                } catch (e) {
                    err(`Error appending buffer: ${e.toString()}`);
                     // if (ms.readyState === 'open') ms.endOfStream('decode');
                }
            };

            if (sourceBuffer.updating) {
                log('SourceBuffer is updating. Waiting for updateend event before initial append.');
                sourceBuffer.addEventListener('updateend', () => {
                    log('SourceBuffer update ended (initial). Appending now.');
                    appendBuffer();
                    if (ms.readyState === 'open' && !sourceBuffer.updating) {
                        log('Ending stream after appending single segment.');
                        ms.endOfStream();
                    }
                }, { once: true });
            } else {
                appendBuffer();
                if (ms.readyState === 'open' && !sourceBuffer.updating) {
                    log('Ending stream after appending single segment.');
                    ms.endOfStream();
                }
            }

        } catch (error) {
            err(`Error fetching or processing video data: ${error.toString()}`);
            updateFFmpegStatus('Error: Fetch/Process failed.');
            if (ms.readyState === 'open') {
                ms.endOfStream('network');
            }
        }

        sourceBuffer.addEventListener('update', () => log('SourceBuffer update event.'));
        sourceBuffer.addEventListener('updateend', () => log('SourceBuffer updateend event (final for segment).'));
        sourceBuffer.addEventListener('error', (e) => err(`SourceBuffer error: ${e.toString()}`));
        sourceBuffer.addEventListener('abort', () => err('SourceBuffer append aborted.'));
    }
});
