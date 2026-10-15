const OPTIONS = {
    numChannels: 2,
};

// Spotify delivers loud masters close to 0 dBFS, MP3 encoding then overshoots
// above full scale and players clip it (audible as crackling in loud parts).
// -1.5 dB of headroom keeps the decoded peaks below 1.0.
const HEADROOM_GAIN = Math.pow(10, -1.5 / 20);

// copied next to the offscreen document by webpack, it must not be bundled
// because worklets cannot load the core-js imports babel adds
const WORKLET_URL = 'recorder-worklet.js';

export class Recorder {
    // the worklet module has to be loaded once per AudioContext before
    // the first recording starts
    static async load(context) {
        await context.audioWorklet.addModule(WORKLET_URL);
    }

    constructor(source) {
        this.context = source.context;

        this.input = this.context.createGain();
        this.input.gain.value = HEADROOM_GAIN;
        source.connect(this.input);

        this.initWorker();
    }

    isRecording() {
        return this.node != null;
    }

    startRecording() {
        if (this.isRecording()) {
            return;
        }

        this.node = new AudioWorkletNode(this.context, 'clipinc-recorder', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [OPTIONS.numChannels],
            channelCount: OPTIONS.numChannels,
            channelCountMode: 'explicit',
        });

        // samples go from the audio thread straight to the worker,
        // the port is handed over with 'start' so no sample arrives before it
        const channel = new MessageChannel();
        this.node.port.postMessage({ command: 'start', port: channel.port1 }, [
            channel.port1,
        ]);
        this.worker.postMessage({ command: 'start', port: channel.port2 }, [
            channel.port2,
        ]);

        this.input.connect(this.node);
        // the node is only processed while it is connected to the destination,
        // its output is silent
        this.node.connect(this.context.destination);
    }

    // stops feeding samples to the worker without discarding the track,
    // used while Spotify is paused so the pause is not recorded as silence
    pauseRecording() {
        if (!this.isRecording() || this.paused) {
            return;
        }

        this.input.disconnect();
        this.paused = true;
    }

    resumeRecording() {
        if (!this.isRecording() || !this.paused) {
            return;
        }

        this.input.connect(this.node);
        this.paused = false;
    }

    cancelRecording() {
        if (!this.isRecording()) {
            return;
        }

        this.releaseNode('cancel');
        this.worker.postMessage({ command: 'cancel' });
    }

    finishRecording(track) {
        if (!this.isRecording()) {
            return;
        }

        // the worklet sends its last batch and an 'end' marker to the worker,
        // the worker waits for it before encoding
        this.releaseNode('flush');

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

    // stops the worklet, the node stays connected (and alive) until the
    // processor confirmed the command
    releaseNode(command) {
        const node = this.node;
        this.input.disconnect();
        node.port.onmessage = ({ data }) => {
            if (data.command === 'stopped') {
                node.disconnect();
                node.port.close();
            }
        };
        node.port.postMessage({ command });

        delete this.node;
        this.paused = false;
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

        this.worker.postMessage({
            command: 'init',
            config: {
                sampleRate: this.context.sampleRate,
                numChannels: OPTIONS.numChannels,
            },
            options: OPTIONS,
        });
    }

    onEncodingProgress(recorder, progress) {}

    onComplete(recorder, track, arrayBuffer) {}

    onError(recorder, error) {}
}
