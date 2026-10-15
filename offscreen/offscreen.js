import { Recorder } from '../background-page/recorder';

let mediaRecorder = null;
let stream = null;
// tracks handed to a worker for encoding that have not been downloaded yet,
// the service worker must not close this document while encodings are pending
let pendingEncodings = 0;

// Signal to the service worker that we're ready to receive messages
console.debug('Offscreen document loaded, sending ready signal');
chrome.runtime.sendMessage({ command: 'offscreen:ready' });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { command, data } = message;

    // Only handle messages intended for us (offscreen: prefix)
    if (!command.startsWith('offscreen:')) {
        return false;
    }

    console.debug('Offscreen received:', command);

    switch (command) {
        case 'offscreen:startCapture':
            handleStartCapture(data).then(
                () => sendResponse({ success: true }),
                (err) => {
                    console.error('offscreen startCapture failed:', err);
                    sendResponse({ success: false });
                },
            );
            return true;

        case 'offscreen:stopCapture':
            handleStopCapture();
            sendResponse({ pendingEncodings });
            break;

        case 'offscreen:getPending':
            sendResponse({ pendingEncodings });
            break;

        case 'offscreen:spotifyPlay':
            console.debug(
                'Offscreen: startRecording, mediaRecorder exists:',
                !!mediaRecorder,
            );
            if (mediaRecorder) {
                mediaRecorder.startRecording();
            }
            break;

        case 'offscreen:spotifyEnded':
            console.debug(
                'Offscreen: finishRecording, track:',
                data?.track?.title,
                'mediaRecorder exists:',
                !!mediaRecorder,
            );
            if (mediaRecorder && mediaRecorder.isRecording()) {
                pendingEncodings++;
                mediaRecorder.finishRecording(data.track);
            }
            break;

        case 'offscreen:spotifyPause':
            if (mediaRecorder) {
                mediaRecorder.pauseRecording();
            }
            break;

        case 'offscreen:spotifyResume':
            if (mediaRecorder) {
                mediaRecorder.resumeRecording();
            }
            break;

        case 'offscreen:spotifyAbort':
            if (mediaRecorder) {
                mediaRecorder.cancelRecording();
            }
            break;

        case 'offscreen:downloadComplete':
            // This is sent BY us, ignore it here
            break;
    }

    return false;
});

async function handleStartCapture({ streamId }) {
    // Use the streamId to get a MediaStream
    stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
            },
        },
    });

    mediaRecorder = new Recorder(stream.getAudioTracks()[0]);
    mediaRecorder.onComplete = handleRecordingComplete;
    mediaRecorder.onError = handleRecordingError;

    // the captured tab is muted by Chrome and the stream is not played back,
    // so the recording runs silently
}

function handleStopCapture() {
    console.debug('Offscreen: handleStopCapture');
    if (mediaRecorder) {
        // tracks already handed to a worker keep their own callbacks and still
        // get downloaded, only the unfinished track is discarded
        mediaRecorder.stop();
    }
    if (stream) {
        stream.getAudioTracks().forEach((t) => t.stop());
        stream.getTracks().forEach((t) => t.stop());
    }

    mediaRecorder = null;
    stream = null;
}

// Send completed recording to service worker for download
// chrome.downloads API is NOT available in offscreen documents — must go through SW
async function handleRecordingComplete(recorder, track, arrayBuffer) {
    console.debug(
        'handleRecordingComplete',
        track?.title,
        'size:',
        arrayBuffer?.byteLength,
    );

    // Build filename
    const regex = /[^a-zA-Z0-9]/g;
    let filename = 'clipinc';

    if (track.directory) {
        filename = `${filename}/${track.directory.replace(regex, ' ').trim()}`;
    }

    const title = track.title ? track.title.replace(regex, ' ').trim() : '';
    const artist = track.artist ? track.artist.replace(regex, ' ').trim() : '';

    filename = `${filename}/${artist} - ${title}.mp3`;
    console.debug(
        'Offscreen: sending download request to SW, filename:',
        filename,
    );

    // sendMessage only transports JSON, so the file travels as a data URL
    const dataUrl = await blobToDataUrl(
        new Blob([arrayBuffer], { type: 'audio/mpeg' }),
    );
    pendingEncodings = Math.max(0, pendingEncodings - 1);

    chrome.runtime.sendMessage({
        command: 'offscreen:downloadComplete',
        data: { track, filename, dataUrl, pendingEncodings },
    });
}

function handleRecordingError(recorder, message) {
    console.error('Offscreen: recording failed:', message);
    pendingEncodings = Math.max(0, pendingEncodings - 1);

    chrome.runtime.sendMessage({
        command: 'offscreen:recordingFailed',
        data: { message, pendingEncodings },
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
