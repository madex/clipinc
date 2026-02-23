import { Recorder } from '../background-page/recorder';

let audioCtx = null;
let mediaRecorder = null;
let stream = null;
let audioElement = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { command, data } = message;

    switch (command) {
        case 'offscreen:startCapture':
            handleStartCapture(data).then(
                () => sendResponse({ success: true }),
                (err) => {
                    console.error('offscreen startCapture failed:', err);
                    sendResponse({ success: false });
                }
            );
            return true;

        case 'offscreen:stopCapture':
            handleStopCapture();
            break;

        case 'offscreen:setVolume':
            if (audioElement) {
                audioElement.volume = data.volume;
            }
            break;

        case 'offscreen:spotifyPlay':
            if (mediaRecorder) {
                mediaRecorder.startRecording();
            }
            break;

        case 'offscreen:spotifyEnded':
            if (mediaRecorder) {
                mediaRecorder.finishRecording(data.track);
            }
            break;

        case 'offscreen:spotifyAbort':
            if (mediaRecorder) {
                mediaRecorder.cancelRecording();
            }
            break;
    }

    return false;
});

async function handleStartCapture({ streamId, volume }) {
    // Use the streamId to get a MediaStream
    stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
            },
        },
    });

    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);

    mediaRecorder = new Recorder(source);
    mediaRecorder.onComplete = handleRecordingComplete;

    // Restore audio for the user
    audioElement = new Audio();
    audioElement.srcObject = stream;
    audioElement.volume = volume;
    audioElement.play();
}

function handleStopCapture() {
    if (mediaRecorder) {
        mediaRecorder.cancelRecording();
        mediaRecorder.onComplete = () => {};
    }
    if (audioCtx) {
        audioCtx.close();
    }
    if (stream) {
        stream.getAudioTracks().forEach((t) => t.stop());
    }

    audioCtx = null;
    mediaRecorder = null;
    stream = null;
    audioElement = null;
}

// Download directly from offscreen document (blob URLs are context-local)
function handleRecordingComplete(recorder, track) {
    const regex = /[^a-zA-Z0-9]/g;
    let filename = 'clipinc';

    console.debug('track', track);

    if (track.directory) {
        filename = `${filename}/${track.directory.replace(regex, ' ').trim()}`;
    }

    const title = track.title ? track.title.replace(regex, ' ').trim() : '';
    const artist = track.artist ? track.artist.replace(regex, ' ').trim() : '';

    filename = `${filename}/${artist} - ${title}.mp3`;
    console.debug('filename', filename);

    chrome.downloads.download({
        url: track.url,
        filename,
        conflictAction: 'overwrite',
    });

    // Notify service worker for notification + counter update
    chrome.runtime.sendMessage({
        command: 'offscreen:downloadComplete',
        data: { track },
    });
}
