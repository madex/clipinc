const NUM_CH = 2;

// Spotify delivers loud masters close to 0 dBFS, MP3 encoding then overshoots
// above full scale and players clip it (audible as crackling in loud parts).
// -1.5 dB of headroom keeps the decoded peaks below 1.0.
const HEADROOM_GAIN = Math.pow(10, -1.5 / 20);

// AudioData frames (~10 ms each) the processor buffers while the main thread
// of the offscreen document is busy, frames beyond that would be dropped
const MAX_BUFFERED_FRAMES = 1000;

// a timestamp jump larger than this between two frames is a gap in the audio
const GAP_TOLERANCE_US = 2000;

// Chrome delivers no frames while the tab outputs no audio (buffering, next
// track loading). Gaps up to this length during a recording are filled with
// silence so the track keeps its length, longer ones are left out.
const MAX_GAP_FILL_US = 1000000;

// Reads the samples of the captured track directly with a
// MediaStreamTrackProcessor: no AudioContext, so no resampling and no second
// clock that drifts against the capture clock (audible as crackling).
export class Recorder {
    constructor(track) {
        this.sampleRate = track.getSettings().sampleRate || 48000;
        this.recording = false;
        this.paused = false;
        this.gaps = 0;
        this.gapMs = 0;
        this.nextTimestamp = null;

        // eslint-disable-next-line no-undef
        const processor = new MediaStreamTrackProcessor({
            track,
            maxBufferSize: MAX_BUFFERED_FRAMES,
        });
        this.reader = processor.readable.getReader();

        this.initWorker();
        this.readFrames();
    }

    async readFrames() {
        for (;;) {
            let result;
            try {
                result = await this.reader.read();
            } catch (err) {
                console.debug('Recorder: reading frames stopped', err);
                return;
            }
            if (result.done) {
                return;
            }

            const frame = result.value;
            const gapUs = this.checkContinuity(frame);
            if (this.recording && !this.paused) {
                if (gapUs > 0) {
                    this.recordGap(gapUs, frame.sampleRate);
                }
                const buffer = toPlanar(frame);
                this.worker.postMessage(
                    { command: 'record', buffer },
                    buffer.map((ch) => ch.buffer),
                );
            }
            frame.close();
        }
    }

    // returns the length of the gap before this frame in µs, 0 if there is none
    checkContinuity(frame) {
        if (frame.sampleRate !== this.sampleRate) {
            console.debug('Recorder: sample rate', frame.sampleRate);
            this.sampleRate = frame.sampleRate;
            this.postInit(this.worker);
        }

        let gapUs = 0;
        if (this.nextTimestamp !== null) {
            const diff = frame.timestamp - this.nextTimestamp;
            if (diff > GAP_TOLERANCE_US) {
                gapUs = diff;
                console.debug(
                    'Recorder: no audio for',
                    Math.round(diff / 1000),
                    'ms',
                );
            }
        }
        this.nextTimestamp =
            frame.timestamp + (frame.numberOfFrames / frame.sampleRate) * 1e6;
        return gapUs;
    }

    recordGap(gapUs, sampleRate) {
        this.gaps++;
        this.gapMs += Math.round(gapUs / 1000);
        if (gapUs > MAX_GAP_FILL_US) {
            return;
        }

        const length = Math.round((gapUs / 1e6) * sampleRate);
        const buffer = [];
        for (let ch = 0; ch < NUM_CH; ++ch) {
            buffer.push(new Float32Array(length));
        }
        this.worker.postMessage(
            { command: 'record', buffer },
            buffer.map((ch) => ch.buffer),
        );
    }

    isRecording() {
        return this.recording;
    }

    startRecording() {
        if (this.isRecording()) {
            return;
        }

        this.recording = true;
        this.paused = false;
        this.gaps = 0;
        this.gapMs = 0;
        this.nextTimestamp = null;
        this.worker.postMessage({ command: 'start' });
    }

    // stops feeding samples to the worker without discarding the track,
    // used while Spotify is paused so the pause is not recorded as silence
    pauseRecording() {
        this.paused = true;
    }

    resumeRecording() {
        this.paused = false;
        // the pause itself is not a gap
        this.nextTimestamp = null;
    }

    cancelRecording() {
        if (!this.isRecording()) {
            return;
        }

        this.recording = false;
        this.worker.postMessage({ command: 'cancel' });
    }

    finishRecording(track) {
        if (!this.isRecording()) {
            return;
        }

        this.recording = false;
        if (this.gaps > 0) {
            console.warn(
                `Recorder: "${track?.title}" had ${
                    this.gaps
                } gaps without audio (${this.gapMs} ms), gaps up to ${
                    MAX_GAP_FILL_US / 1000
                } ms were filled with silence`,
            );
        }

        // Hand off the current worker for encoding — it will fire onComplete when done
        const oldWorker = this.worker;
        const onComplete = this.onComplete.bind(this);
        const onError = this.onError.bind(this);

        oldWorker.onmessage = (event) => {
            const data = event.data;
            switch (data.command) {
                case 'progress':
                    this.onEncodingProgress(this, data.progress);
                    break;
                case 'complete':
                    onComplete(this, data.track, data.arrayBuffer);
                    oldWorker.terminate();
                    break;
                case 'error':
                    onError(this, data.message);
                    oldWorker.terminate();
                    break;
                default:
                    break;
            }
        };
        oldWorker.postMessage({ command: 'finish', track });

        // Create a fresh worker immediately so startRecording() has a clean slate
        this.worker = null; // prevent initWorker from terminating the old one
        this.initWorker();
    }

    // stops reading the track, the worker of the unfinished track is terminated
    stop() {
        this.cancelRecording();
        this.reader.cancel();
        this.worker.terminate();
    }

    initWorker() {
        if (this.worker != null) {
            this.worker.terminate();
        }

        this.worker = new Worker(new URL('./Mp3Worker.js', import.meta.url));
        this.worker.onmessage = (event) => {
            const data = event.data;
            switch (data.command) {
                case 'progress':
                    this.onEncodingProgress(this, data.progress);
                    break;
                case 'complete':
                    this.onComplete(this, data.track, data.arrayBuffer);
                    break;
                case 'error':
                    this.onError(this, data.message);
                    break;
                default:
                    break;
            }
        };

        this.postInit(this.worker);
    }

    postInit(worker) {
        worker.postMessage({
            command: 'init',
            config: {
                sampleRate: this.sampleRate,
                numChannels: NUM_CH,
            },
        });
    }

    onEncodingProgress(recorder, progress) {}

    onComplete(recorder, track, arrayBuffer) {}

    onError(recorder, error) {}
}

// copies an AudioData frame into one Float32Array per channel (mono is
// duplicated) and applies the headroom gain
function toPlanar(frame) {
    const buffer = [];
    for (let ch = 0; ch < NUM_CH; ++ch) {
        const plane = new Float32Array(frame.numberOfFrames);
        const options = {
            planeIndex: Math.min(ch, frame.numberOfChannels - 1),
        };
        // tab audio usually arrives as f32-planar, convert only if needed
        if (frame.format !== 'f32-planar') {
            options.format = 'f32-planar';
        }
        frame.copyTo(plane, options);
        for (let i = 0; i < plane.length; ++i) {
            plane[i] *= HEADROOM_GAIN;
        }
        buffer.push(plane);
    }
    return buffer;
}
