import { Recorder } from '../background-page/recorder';

let audioCtx = null;
let mediaRecorder = null;
let stream = null;
let audioElement = null;

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
            console.debug('Offscreen: startRecording, mediaRecorder exists:', !!mediaRecorder);
            if (mediaRecorder) {
                mediaRecorder.startRecording();
            }
            break;

        case 'offscreen:spotifyEnded':
            console.debug('Offscreen: finishRecording, track:', data?.track?.title, 'mediaRecorder exists:', !!mediaRecorder);
            if (mediaRecorder) {
                mediaRecorder.finishRecording(data.track);
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

    // Restore audio for the user via Audio element
    audioElement = new Audio();
    audioElement.srcObject = stream;
    audioElement.volume = volume;

    try {
        await audioElement.play();
        console.debug('Offscreen: audio playback started via Audio element');
    } catch (err) {
        console.warn('Offscreen: Audio element play() failed, using AudioContext fallback:', err.message);
        // Fallback: route the captured audio through AudioContext destination
        // This makes the audio audible even when autoplay is blocked on Audio elements
        try {
            const playbackSource = audioCtx.createMediaStreamSource(stream);
            playbackSource.connect(audioCtx.destination);
            console.debug('Offscreen: audio playback started via AudioContext destination');
        } catch (fallbackErr) {
            console.error('Offscreen: AudioContext fallback also failed:', fallbackErr.message);
        }
    }
}

function handleStopCapture() {
    console.debug('Offscreen: handleStopCapture');
    if (mediaRecorder) {
        mediaRecorder.cancelRecording();
        mediaRecorder.onComplete = () => {};
    }
    // Stop audio playback first
    if (audioElement) {
        audioElement.pause();
        audioElement.srcObject = null;
    }
    if (audioCtx) {
        audioCtx.close();
    }
    if (stream) {
        stream.getAudioTracks().forEach((t) => t.stop());
        stream.getTracks().forEach((t) => t.stop());
    }

    audioCtx = null;
    mediaRecorder = null;
    stream = null;
    audioElement = null;
}

// Send completed recording to service worker for download
// chrome.downloads API is NOT available in offscreen documents — must go through SW
function handleRecordingComplete(recorder, track, arrayBuffer) {
    console.debug('handleRecordingComplete', track?.title, 'size:', arrayBuffer?.byteLength);

    // Build filename
    const regex = /[^a-zA-Z0-9]/g;
    let filename = 'clipinc';

    if (track.directory) {
        filename = `${filename}/${track.directory.replace(regex, ' ').trim()}`;
    }

    const title = track.title ? track.title.replace(regex, ' ').trim() : '';
    const artist = track.artist ? track.artist.replace(regex, ' ').trim() : '';

    filename = `${filename}/${artist} - ${title}.mp3`;
    console.debug('Offscreen: sending download request to SW, filename:', filename);

    // Convert ArrayBuffer to base64 data URL for transfer via sendMessage
    // (sendMessage does not support transferable objects / ArrayBuffers)
    const dataUrl = arrayBufferToDataUrl(arrayBuffer);

    chrome.runtime.sendMessage({
        command: 'offscreen:downloadComplete',
        data: { track, filename, dataUrl },
    });
}

function arrayBufferToDataUrl(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return 'data:audio/mpeg;base64,' + btoa(binary);
}
