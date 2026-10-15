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

// Reads the samples of the captured track directly with a
// MediaStreamTrackProcessor: no AudioContext, so no resampling and no second
// clock that drifts against the capture clock (audible as crackling).
export class Recorder {
    constructor(track) {
        this.sampleRate = track.getSettings().sampleRate || 48000;
        this.recording = false;
        this.paused = false;
        this.gaps = 0;
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
            this.checkContinuity(frame);
            if (this.recording && !this.paused) {
                const buffer = toPlanar(frame);
                this.worker.postMessage(
                    { command: 'record', buffer },
                    buffer.map((ch) => ch.buffer),
                );
            }
            frame.close();
        }
    }

    checkContinuity(frame) {
        if (frame.sampleRate !== this.sampleRate) {
            console.debug('Recorder: sample rate', frame.sampleRate);
            this.sampleRate = frame.sampleRate;
            this.postInit(this.worker);
        }

        if (
            this.nextTimestamp !== null &&
            Math.abs(frame.timestamp - this.nextTimestamp) > GAP_TOLERANCE_US
        ) {
            if (this.recording && !this.paused) {
                this.gaps++;
            }
            console.warn(
                'Recorder: gap in captured audio',
                Math.round(frame.timestamp - this.nextTimestamp),
                'µs',
            );
        }
        this.nextTimestamp =
            frame.timestamp + (frame.numberOfFrames / frame.sampleRate) * 1e6;
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
        this.worker.postMessage({ command: 'start' });
    }

    // stops feeding samples to the worker without discarding the track,
    // used while Spotify is paused so the pause is not recorded as silence
    pauseRecording() {
        this.paused = true;
    }

    resumeRecording() {
        this.paused = false;
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
        console.debug('Recorder: finished track with', this.gaps, 'gaps');

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
