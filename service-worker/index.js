// reset storage after installation
chrome.runtime.onInstalled.addListener(resetStorage);

// reset storage when chrome starts
chrome.runtime.onStartup.addListener(() => {
    resetStorage();
    closeOffscreenDocument();
});

// handle tab / window removed
chrome.tabs.onRemoved.addListener(handleTabRemove);
chrome.windows.onRemoved.addListener(handleWindowRemove);

let recordingTabId = null;
let updateListenerActive = false;

// ---- Offscreen Document Lifecycle ----

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existingContexts.length > 0) return;

    if (creatingOffscreen) {
        await creatingOffscreen;
    } else {
        creatingOffscreen = chrome.offscreen.createDocument({
            url: 'offscreen/index.html',
            reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
            justification: 'Recording tab audio and encoding to MP3',
        });
        await creatingOffscreen;
        creatingOffscreen = null;
    }

    // Wait for the offscreen document to signal it's ready
    await waitForOffscreenReady();
}

function waitForOffscreenReady() {
    return new Promise((resolve) => {
        function listener(message) {
            if (message.command === 'offscreen:ready') {
                chrome.runtime.onMessage.removeListener(listener);
                resolve();
            }
        }
        chrome.runtime.onMessage.addListener(listener);

        // Timeout fallback - resolve after 2s even if no ready signal
        setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
            resolve();
        }, 2000);
    });
}

async function closeOffscreenDocument() {
    try {
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
        });
        if (existingContexts.length > 0) {
            await chrome.offscreen.closeDocument();
        }
    } catch (e) {
        console.debug('closeOffscreenDocument:', e);
    }
}

// ---- Message Router ----

chrome.runtime.onMessage.addListener(
    ({ command, data }, sender, sendResponse) => {
        // Ignore messages intended for the offscreen document (sent by us)
        // But handle offscreen:downloadComplete (from offscreen → SW) and offscreen:ready
        if (command.startsWith('offscreen:') && command !== 'offscreen:downloadComplete' && command !== 'offscreen:ready') {
            return false;
        }

        switch (command) {
            // From popup: start capture
            case 'startCapture':
                startCapture().then(
                    () => {
                        sendResponse({ success: true });
                    },
                    (err) => {
                        console.error('startCapture failed:', err);
                        sendResponse({ success: false });
                    }
                );
                return true;

            // From content script: media events - forward to offscreen
            case 'spotifyPlay':
                console.debug('SW: spotifyPlay received');
                chrome.storage.local.set({ track: data.track });
                sendToOffscreen('offscreen:spotifyPlay');
                break;

            case 'spotifyUpdateTrack':
                chrome.storage.local.set({ track: data.track });
                break;

            case 'spotifyEnded': {
                console.debug('SW: spotifyEnded received');
                // Use track from the message (sent by content script) to avoid
                // race condition with spotifyPlay overwriting storage
                const endedTrack = data.track;
                if (endedTrack && endedTrack.type === 'ad') {
                    console.debug('SW: ad detected, aborting');
                    sendToOffscreen('offscreen:spotifyAbort');
                    break;
                }
                console.debug('SW: sending offscreen:spotifyEnded with track', endedTrack?.title);
                sendToOffscreen('offscreen:spotifyEnded', { track: endedTrack });
                break;
            }

            case 'spotifyAbort':
                sendToOffscreen('offscreen:spotifyAbort');
                break;

            case 'spotifyPause':
                // Ignore pause - the audio capture stream records continuously.
                // We only react to track changes (spotifyEnded/spotifyPlay).
                console.debug('SW: spotifyPause received - ignoring (continuous recording)');
                break;

            case 'stopCapture':
                stopRecording();
                break;

            case 'setVolume':
                chrome.storage.local.set({ volume: data.volume });
                sendToOffscreen('offscreen:setVolume', { volume: data.volume });
                break;

            // From offscreen: recording complete, download the MP3
            case 'offscreen:downloadComplete':
                console.debug('SW: recording complete for', data.track?.title, 'filename:', data.filename);
                handleDownloadComplete(data.track, data.filename, data.dataUrl);
                break;
        }

        return false;
    }
);

// Helper to send messages to the offscreen document
function sendToOffscreen(command, data) {
    chrome.runtime.sendMessage({ command, data }).catch((err) => {
        console.error('sendToOffscreen failed:', command, err);
    });
}

// ---- Tab Capture (MV3 pattern) ----

async function startCapture() {
    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    const tab = tabs[0];

    // Try to reach the content script; if it doesn't exist yet, inject it
    let response;
    try {
        response = await chrome.tabs.sendMessage(tab.id, {
            command: 'prepareRecording',
        });
    } catch (err) {
        console.debug('Content script not reachable, injecting...', err.message);
        // Inject content script programmatically
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/content.js'],
        });
        await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content/slider.css'],
        });
        // Wait a moment for the content script to initialize
        await new Promise((r) => setTimeout(r, 1500));
        // Try again
        response = await chrome.tabs.sendMessage(tab.id, {
            command: 'prepareRecording',
        });
    }

    if (!response) {
        throw new Error('Content script did not respond to prepareRecording');
    }

    if (response.error) {
        chrome.notifications.create(
            'clipincError',
            {
                type: 'basic',
                title: chrome.i18n.getMessage('name'),
                message: chrome.i18n.getMessage('errorChangeDevice'),
                iconUrl: '/assets/images/clipinc-128.png',
            },
            console.debug.bind(console)
        );
        throw new Error(response.error);
    }

    console.debug('SW: prepareRecording OK, volume:', response.volume);

    // Get a streamId using MV3 tabCapture API
    const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
    });

    // Create offscreen document
    await ensureOffscreenDocument();

    // Send streamId to offscreen document to start actual capture
    const captureResponse = await chrome.runtime.sendMessage({
        command: 'offscreen:startCapture',
        data: {
            streamId,
            volume: response.volume,
        },
    });

    if (!captureResponse || !captureResponse.success) {
        throw new Error('Offscreen capture failed');
    }

    // Set up tab update listener for navigation detection
    recordingTabId = tab.id;
    if (!updateListenerActive) {
        chrome.tabs.onUpdated.addListener(updateListener);
        updateListenerActive = true;
    }

    // Tell content script to start playback
    chrome.tabs.sendMessage(tab.id, { command: 'startRecording' });

    chrome.storage.local.set({
        isRecording: true,
        tabId: tab.id,
        songCount: 0,
        volume: response.volume,
    });
    setRecordingIcon();
}

function stopRecording() {
    chrome.runtime.sendMessage({ command: 'offscreen:stopCapture' });

    if (updateListenerActive) {
        chrome.tabs.onUpdated.removeListener(updateListener);
        updateListenerActive = false;
    }

    chrome.storage.local.get(['tabId', 'volume'], ({ tabId, volume }) => {
        if (tabId) {
            chrome.tabs.sendMessage(tabId, {
                command: 'stopRecording',
                data: { volume: volume || 1 },
            });
        }
    });

    reset();
    closeOffscreenDocument();

    chrome.notifications.create(
        'clipincStop',
        {
            type: 'basic',
            title: chrome.i18n.getMessage('name'),
            message: chrome.i18n.getMessage('notificationStop'),
            iconUrl: '/assets/images/clipinc-128.png',
        },
        console.debug.bind(console)
    );
}

// ---- Handlers ----

function updateListener(id, changeInfo) {
    if (recordingTabId === id && changeInfo.status === 'loading') {
        stopRecording();
    }
}

function handleDownloadComplete(track, filename, dataUrl) {
    // Perform the actual download in the service worker
    // (chrome.downloads is NOT available in offscreen documents)
    if (dataUrl && filename) {
        console.debug('SW: starting download', filename, 'size ~', Math.round(dataUrl.length * 0.75 / 1024), 'KB');
        chrome.downloads.download(
            {
                url: dataUrl,
                filename,
                conflictAction: 'overwrite',
            },
            (downloadId) => {
                if (chrome.runtime.lastError) {
                    console.error('SW: Download failed:', chrome.runtime.lastError.message);
                } else {
                    console.debug('SW: Download started, id:', downloadId);
                }
            }
        );

        chrome.downloads.onChanged.addListener(cleanDownloadShelf);
    }

    chrome.storage.local.get(['songCount'], ({ songCount }) => {
        songCount++;
        chrome.storage.local.set({ songCount });
        chrome.runtime.sendMessage(undefined, {
            command: 'downloaded',
            data: { songCount },
        });
    });

    let message = chrome.i18n.getMessage('notificationDownloaded');
    message = message.replace('##TITLE##', track.title);
    message = message.replace('##ARTIST##', track.artist);

    chrome.notifications.create(
        'clipincDownloaded',
        {
            type: 'basic',
            title: chrome.i18n.getMessage('name'),
            message,
            iconUrl: '/assets/images/clipinc-128.png',
        },
        console.debug.bind(console)
    );
}

// remove files from download shelf to stop spam
function cleanDownloadShelf(delta) {
    if (!delta || !delta.state || delta.state.current !== 'complete') {
        return;
    }

    chrome.downloads.search({ id: delta.id }, (downloads) => {
        if (downloads[0].filename.indexOf('clipinc') === -1) {
            return;
        }

        chrome.downloads.erase({ id: delta.id });
        chrome.downloads.onChanged.removeListener(cleanDownloadShelf);
    });
}

// delete storage if the tab that was recorded is closed
function handleTabRemove(id) {
    if (recordingTabId && id === recordingTabId) {
        stopRecording();
    }
}

// delete storage if the window that was recording was closed
function handleWindowRemove() {
    if (!recordingTabId) return;

    chrome.tabs.get(recordingTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            stopRecording();
        }
    });
}

// clear storage
function resetStorage() {
    chrome.storage.local.set({
        isRecording: false,
        tabId: 0,
        track: null,
        songCount: 0,
        volume: 1,
    });
}

// set icon to default
// Paths must be relative to extension root (not to service worker location)
function setDefaultIcon() {
    chrome.action.setIcon({
        path: {
            16: '/assets/images/clipinc-16.png',
            32: '/assets/images/clipinc-32.png',
            48: '/assets/images/clipinc-48.png',
            128: '/assets/images/clipinc-128.png',
        },
    }).catch((err) => console.warn('setDefaultIcon failed:', err));
}

// set icon to recording
function setRecordingIcon() {
    chrome.action.setIcon({
        path: {
            16: '/assets/images/clipinc-16-record.png',
            32: '/assets/images/clipinc-32-record.png',
            48: '/assets/images/clipinc-48-record.png',
            128: '/assets/images/clipinc-128-record.png',
        },
    }).catch((err) => console.warn('setRecordingIcon failed:', err));
}

function reset() {
    resetStorage();
    setDefaultIcon();
    recordingTabId = null;
}
