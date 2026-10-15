/* eslint-env worker */
/* global Mp3LameEncoder, ID3Writer */

importScripts('./encoders/Mp3Encoder.min.js');
importScripts('./encoders/browser-id3-writer.js');

const NUM_CH = 2;
let sampleRate = 44100,
    options = undefined,
    encoder = undefined,
    recBuffers = undefined,
    bufferCount = 0,
    // samples arrive from the AudioWorklet through this port
    samplePort = undefined,
    // set when the worklet sent its last batch
    samplesEnded = false,
    // a finish that waits for the last batch of the worklet
    pendingTrack = undefined;

function error(message) {
    console.debug('error');
    self.postMessage({ command: 'error', message: `Mp3Worker: ${message}` });
}

function init(data) {
    console.debug('init');
    if (data.config.numChannels === NUM_CH) {
        sampleRate = data.config.sampleRate;
        options = data.options;
    } else {
        error(`numChannels must be ${NUM_CH}`);
    }
}

function start(port) {
    console.debug('start');
    recBuffers = [];
    samplesEnded = false;
    pendingTrack = undefined;

    samplePort = port;
    samplePort.onmessage = ({ data }) => {
        switch (data.command) {
            case 'record':
                record(data.buffer);
                break;
            case 'end':
                samplesEnded = true;
                closeSamplePort();
                if (pendingTrack) {
                    const track = pendingTrack;
                    pendingTrack = undefined;
                    finish(track);
                }
                break;
            default:
                break;
        }
    };
}

function closeSamplePort() {
    if (samplePort) {
        samplePort.onmessage = null;
        samplePort.close();
        samplePort = undefined;
    }
}

function record(buffer) {
    //console.debug('record', bufferCount, buffer);
    if (!recBuffers) {
        // Safety: if record is called before start, initialize buffers
        recBuffers = [];
    }
    bufferCount++;
    recBuffers.push(buffer);
}

function postProgress(progress) {
    //console.debug('progress', progress);
    self.postMessage({ command: 'progress', progress });
}

function finish(track) {
    if (samplePort && !samplesEnded) {
        // the last batch of the worklet is still on its way,
        // do not wait forever if the worklet is gone
        pendingTrack = track;
        setTimeout(() => {
            if (pendingTrack === track) {
                console.warn(
                    'Mp3Worker: no end from worklet, finishing anyway',
                );
                pendingTrack = undefined;
                closeSamplePort();
                finish(track);
            }
        }, 2000);
        return;
    }

    console.debug('finish', recBuffers);

    if (!recBuffers || recBuffers.length === 0) {
        cleanup();
        error('no audio samples recorded');
        return;
    }

    postProgress(0);
    encoder = new Mp3LameEncoder(sampleRate, track.kbps);
    let timeout = Date.now() + 1000;
    while (recBuffers.length > 0) {
        encoder.encode(recBuffers.shift());
        let now = Date.now();
        if (now > timeout) {
            postProgress((bufferCount - recBuffers.length) / bufferCount);
            timeout = now + 1000;
        }
    }
    postProgress(1);

    // save variables locally so cleanup can be run
    const blob = encoder.finish('audio/mpeg');
    cleanup();

    const filePromise = new Promise((resolve) => {
        const fileReader = new FileReader();
        fileReader.onload = (event) => resolve(event.target.result);
        fileReader.readAsArrayBuffer(blob);
    });

    // Cover is optional - if no URL works, the MP3 is produced without cover art
    const coverUrls = [track.cover, track.coverFallback].filter(Boolean);
    const imagePromise = fetchFirstCover(coverUrls).catch((err) => {
        console.warn(
            'Mp3Worker: cover fetch failed, proceeding without cover:',
            err.message,
        );
        return null;
    });

    Promise.all([filePromise, imagePromise])
        .then(([file, cover]) => {
            console.debug('got file', cover ? 'and image' : '(no cover)');

            const writer = new ID3Writer(file);
            writer
                .setFrame('TPE1', [track.artist || 'Unknown'])
                .setFrame('TIT2', track.title || 'Unknown')
                .setFrame('TLEN', track.duration || 0);

            if (
                cover &&
                cover.arrayBuffer &&
                cover.arrayBuffer.byteLength > 0
            ) {
                writer.setFrame('APIC', {
                    type: 3,
                    data: cover.arrayBuffer,
                    description: '',
                    mimeType: cover.mimeType,
                });
            }

            if (track.album) {
                writer.setFrame('TALB', track.album);
            }

            if (track.albumArtist) {
                writer.setFrame('TPE2', track.albumArtist);
            }

            if (track.albumReleaseDate) {
                writer.setFrame('TDAT', track.albumReleaseDate);
            }

            if (track.albumReleaseYear) {
                writer.setFrame('TYER', track.albumReleaseYear);
            }

            if (track.discNumber) {
                writer.setFrame('TPOS', track.discNumber);
            }

            if (track.trackNumber) {
                writer.setFrame('TRCK', track.trackNumber);
            }

            writer.addTag();

            console.debug('done');
            // Send the raw ArrayBuffer instead of a blob URL.
            // Blob URLs are context-local and cannot cross worker boundaries.
            const taggedArrayBuffer = writer.arrayBuffer;
            self.postMessage(
                {
                    command: 'complete',
                    track,
                    arrayBuffer: taggedArrayBuffer,
                },
                [taggedArrayBuffer],
            );
        })
        .catch((err) => {
            console.error('Mp3Worker: encoding/tagging failed:', err);
            self.postMessage({
                command: 'error',
                message: 'Encoding failed: ' + err.message,
            });
        });
}

// tries the urls in order, the first one that loads wins
function fetchFirstCover(urls) {
    return urls.reduce(
        (previous, url) =>
            previous.catch(() =>
                fetch(url).then((res) => {
                    if (!res.ok) {
                        throw new Error(`Cover fetch returned ${res.status}`);
                    }
                    return res.arrayBuffer().then((arrayBuffer) => ({
                        arrayBuffer,
                        mimeType:
                            res.headers.get('Content-Type') || 'image/jpeg',
                    }));
                }),
            ),
        Promise.reject(new Error('no cover url')),
    );
}

function cleanup() {
    console.debug('cleanup');
    closeSamplePort();
    encoder = recBuffers = undefined;
    bufferCount = 0;
}

self.onmessage = function (event) {
    let data = event.data;
    switch (data.command) {
        case 'init':
            init(data);
            break;
        case 'start':
            start(data.port);
            break;
        case 'finish':
            finish(data.track);
            break;
        case 'cancel':
            cleanup();
    }
};
