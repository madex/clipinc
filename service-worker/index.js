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
                chrome.storage.local.set({ track: data.track });
                chrome.runtime.sendMessage({
                    command: 'offscreen:spotifyPlay',
                });
                break;

            case 'spotifyUpdateTrack':
                chrome.storage.local.set({ track: data.track });
                break;

            case 'spotifyEnded':
                chrome.storage.local.get(['track'], ({ track }) => {
                    if (track && track.type === 'ad') {
                        chrome.runtime.sendMessage({
                            command: 'offscreen:spotifyAbort',
                        });
                        return;
                    }
                    chrome.runtime.sendMessage({
                        command: 'offscreen:spotifyEnded',
                        data: { track },
                    });
                });
                break;

            case 'spotifyAbort':
                chrome.runtime.sendMessage({
                    command: 'offscreen:spotifyAbort',
                });
                break;

            case 'spotifyPause':
            case 'stopCapture':
                stopRecording();
                break;

            case 'setVolume':
                chrome.storage.local.set({ volume: data.volume });
                chrome.runtime.sendMessage({
                    command: 'offscreen:setVolume',
                    data: { volume: data.volume },
                });
                break;

            // From offscreen: download completed
            case 'offscreen:downloadComplete':
                handleDownloadComplete(data.track);
                break;
        }

        return false;
    }
);

// ---- Tab Capture (MV3 pattern) ----

async function startCapture() {
    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    const tab = tabs[0];

    // Ask content script to prepare
    const response = await chrome.tabs.sendMessage(tab.id, {
        command: 'prepareRecording',
    });

    if (response && response.error) {
        chrome.notifications.create(
            'clipincError',
            {
                type: 'basic',
                title: chrome.i18n.getMessage('name'),
                message: chrome.i18n.getMessage('errorChangeDevice'),
                iconUrl: 'assets/images/clipinc-128.png',
            },
            console.debug.bind(console)
        );
        throw new Error(response.error);
    }

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
            iconUrl: 'assets/images/clipinc-128.png',
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

function handleDownloadComplete(track) {
    chrome.downloads.onChanged.addListener(cleanDownloadShelf);

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
            iconUrl: 'assets/images/clipinc-128.png',
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
function setDefaultIcon() {
    chrome.action.setIcon({
        path: {
            16: 'assets/images/clipinc-16.png',
            32: 'assets/images/clipinc-32.png',
            48: 'assets/images/clipinc-48.png',
            128: 'assets/images/clipinc-128.png',
        },
    });
}

// set icon to recording
function setRecordingIcon() {
    chrome.action.setIcon({
        path: {
            16: 'assets/images/clipinc-16-record.png',
            32: 'assets/images/clipinc-32-record.png',
            48: 'assets/images/clipinc-48-record.png',
            128: 'assets/images/clipinc-128-record.png',
        },
    });
}

function reset() {
    resetStorage();
    setDefaultIcon();
    recordingTabId = null;
}
