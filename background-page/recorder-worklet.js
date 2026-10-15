// Runs on the audio rendering thread, so samples are not lost when the main
// thread of the (hidden, throttled) offscreen document is busy. Samples are
// sent in batches straight to the Mp3Worker through a MessagePort.

const NUM_CH = 2;
const BATCH_FRAMES = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.out = null;
        this.done = false;
        this.newBatch();

        this.port.onmessage = ({ data }) => {
            switch (data.command) {
                case 'start':
                    this.out = data.port;
                    break;
                case 'flush':
                    if (this.out) {
                        this.send();
                        this.out.postMessage({ command: 'end' });
                    }
                    this.stop();
                    break;
                case 'cancel':
                    this.stop();
                    break;
                default:
                    break;
            }
        };
    }

    newBatch() {
        this.batch = [];
        for (let ch = 0; ch < NUM_CH; ++ch) {
            this.batch[ch] = new Float32Array(BATCH_FRAMES);
        }
        this.filled = 0;
    }

    send() {
        if (!this.out || this.filled === 0) {
            return;
        }

        const buffer = this.batch.map((ch) => ch.subarray(0, this.filled));
        this.out.postMessage(
            { command: 'record', buffer },
            this.batch.map((ch) => ch.buffer),
        );
        this.newBatch();
    }

    stop() {
        this.out = null;
        this.done = true;
        // tell the main thread the node can be disconnected
        this.port.postMessage({ command: 'stopped' });
    }

    process(inputs) {
        if (this.done) {
            return false;
        }

        const input = inputs[0];
        if (!this.out || !input || input.length === 0) {
            return true;
        }

        const frames = input[0].length;
        if (this.filled + frames > BATCH_FRAMES) {
            this.send();
        }

        for (let ch = 0; ch < NUM_CH; ++ch) {
            this.batch[ch].set(input[ch] || input[0], this.filled);
        }
        this.filled += frames;

        if (this.filled === BATCH_FRAMES) {
            this.send();
        }

        return true;
    }
}

registerProcessor('clipinc-recorder', RecorderProcessor);
