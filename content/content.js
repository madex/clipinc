import './inject';

// Guard against double injection (manifest + programmatic)
if (window.__clipincLoaded) {
    console.debug('clipinc: content script already loaded, skipping re-initialization');
    // Stop execution - functions below will be defined but never called
    // The original instance's message listener and polling are already active
}
const __clipincFirstLoad = !window.__clipincLoaded;
window.__clipincLoaded = true;

let trackTimeout;

// ---- DOM Polling State ----
let pollingInterval = null;
let lastTrackTitle = null;
let lastTrackInfo = null;     // cached track info for the currently recording track
let isRecordingTrack = false;  // true while we have an active track being recorded

// ---- DOM Polling Functions ----

function startPolling() {
    console.debug('clipinc: startPolling');
    lastTrackTitle = null;
    lastTrackInfo = null;
    isRecordingTrack = false;
    // Clear any existing interval
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    pollingInterval = setInterval(pollSpotifyState, 1000);
    // Run first check after a short delay to let the UI settle
    setTimeout(pollSpotifyState, 500);
}

function stopPolling() {
    console.debug('clipinc: stopPolling');
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
    lastTrackTitle = null;
    lastTrackInfo = null;
    isRecordingTrack = false;
}

function pollSpotifyState() {
    const isPlaying = isSpotifyPlaying();
    const currentTitle = getCurrentTitle();
    const currentArtist = getCurrentArtist();

    // Build a unique track key from title + artist
    const trackKey = currentTitle && currentArtist
        ? `${currentTitle}|||${currentArtist}`
        : currentTitle;

    // Debug: log state every 10 seconds
    if (!pollSpotifyState._count) pollSpotifyState._count = 0;
    pollSpotifyState._count++;
    if (pollSpotifyState._count % 10 === 1) {
        console.debug('clipinc: poll state - playing:', isPlaying,
            'recording:', isRecordingTrack,
            'title:', currentTitle, 'artist:', currentArtist);
    }

    // Case 1: Track change while playing (most important - triggers download of previous track)
    if (isPlaying && trackKey && trackKey !== lastTrackTitle) {
        if (isRecordingTrack && lastTrackTitle !== null) {
            // Previous track ended -> trigger save/download
            console.debug('clipinc: track changed → ending previous track');
            handlePlayerEnded();
        }
        lastTrackTitle = trackKey;
        isRecordingTrack = true;
        console.debug('clipinc: new track → start recording:', currentTitle, '-', currentArtist);
        handlePlayerPlay();
        return;
    }

    // Case 2: First detection when starting (track already playing, not yet known)
    if (isPlaying && trackKey && lastTrackTitle === null) {
        lastTrackTitle = trackKey;
        isRecordingTrack = true;
        console.debug('clipinc: initial track detected:', currentTitle, '-', currentArtist);
        handlePlayerPlay();
        return;
    }

    // Case 3: Ignore pause/resume flapping - the recorder records continuously.
    // We only care about track changes, not play/pause state.
    // The audio capture stream keeps recording regardless of Spotify's play state.
}

/**
 * Checks if Spotify is currently playing by inspecting the play/pause button's aria-label.
 * aria-label "Pause" = currently playing (button would pause if clicked)
 * aria-label "Play" = currently paused (button would play if clicked)
 * Confirmed working from user logs: btn aria-label: Pause / Play
 */
function isSpotifyPlaying() {
    const btn = document.querySelector('[data-testid="control-button-playpause"]');
    if (!btn) return false;

    const label = (btn.getAttribute('aria-label') || '').toLowerCase();

    // "Pause" or "Pausieren" (DE) → currently playing
    // Note: "pausieren" does NOT contain "pause" (it's paus-i-e-ren), so we check for "paus"
    if (label.includes('paus')) return true;
    // "Play" or "Abspielen" (DE) or "Wiedergabe" (DE) → currently paused
    if (label.includes('play') || label.includes('abspielen') || label.includes('wiedergabe')) return false;

    // Fallback: check SVG path
    const playIconPath = btn.querySelector('path[d*="M3 1.713"]');
    if (playIconPath) return false;

    return true;
}

function getCurrentTitle() {
    const el = document.querySelector(
        '[data-testid="context-item-info-title"]'
    );
    return el?.textContent || null;
}

function getCurrentArtist() {
    const el = document.querySelector(
        '[data-testid="context-item-info-subtitles"]'
    );
    return el?.textContent || null;
}

// ---- Player Event Handlers ----

// handle player play event
function handlePlayerPlay() {
    lastTrackInfo = getLocalTrackInfo();
    chrome.runtime.sendMessage(
        { command: 'spotifyPlay', data: { track: lastTrackInfo } }
    );
    trackTimeout = setTimeout(() => {
        getTrackInfo().then((track) => {
            lastTrackInfo = track;
            chrome.runtime.sendMessage({
                command: 'spotifyUpdateTrack',
                data: { track },
            });
        });
    }, 1000);
}

// handle player ended event — sends the CURRENT track info so the SW
// doesn't need to read it from storage (avoids race condition with spotifyPlay)
function handlePlayerEnded() {
    clearTimeout(trackTimeout);
    chrome.runtime.sendMessage({
        command: 'spotifyEnded',
        data: { track: lastTrackInfo },
    });
}

// handle player abort event
function handlePlayerAbort() {
    clearTimeout(trackTimeout);
    chrome.runtime.sendMessage({ command: 'spotifyAbort', data: {} });
}

// handle player pause event
function handlePlayerPause() {
    chrome.runtime.sendMessage({ command: 'spotifyPause', data: {} });
}

// handle player volume change event
function handlePlayerVolumeInput(event) {
    chrome.runtime.sendMessage({
        command: 'setVolume',
        data: { volume: parseFloat(event.target.value) },
    });
}

// ---- Track Info Functions ----

/**
 * Checks if current playing Track is in an Album
 * @returns {boolean}
 */
function isAlbumTrack() {
    const playIcon = document.querySelector('.cover-art-playback playing');
    return false;
}

/**
 * Searches in the DOM for the album name
 * @returns {string}
 */
function getAlbumName() {
    const trackList = document.querySelector('div[data-testid="track-list"]');
    return trackList ? trackList.getAttribute('aria-label') || '' : '';
}

/**
 * Searches in the DOM for the playlist name
 * @returns {string}
 */
function getPlayListName() {
    const trackList = document.querySelector(
        'div[data-testid="playlist-tracklist"]'
    );
    return trackList?.getAttribute('aria-label') || '';
}

/**
 * Checks if the current playing Track is in a Playlist
 * @returns {boolean}
 */
function isTrackInPlayList() {
    const playlist = document.querySelector(
        'div[data-testid="playlist-tracklist"]'
    );
    return Boolean(playlist);
}

// get track info from dom (with API fallback)
const getTrackInfo = () =>
    new Promise((resolve) => {
        let directoryName = '';
        const isPlaylistTrack = isTrackInPlayList();

        if (!isPlaylistTrack) {
            directoryName = getAlbumName();
        } else {
            directoryName = getPlayListName();
        }
        const isPremium = document.querySelector('.AdsContainer') === null;

        fetch(
            'https://open.spotify.com/get_access_token?reason=transport&productType=web_player'
        )
            .then((data) => {
                if (!data.ok) {
                    throw new Error(`get_access_token returned ${data.status}`);
                }
                return data.json();
            })
            .then((json) => {
                if (json.accessToken && json.accessToken !== '') {
                    fetch('https://api.spotify.com/v1/me/player', {
                        headers: {
                            Authorization: `Bearer ${json.accessToken}`,
                        },
                    })
                        .then((res) => {
                            if (!res.ok) {
                                throw new Error(`Spotify API returned ${res.status}`);
                            }
                            return res.json();
                        })
                        .then((t) => {
                            if (t.currently_playing_type === 'ad') {
                                const track = getLocalTrackInfo();
                                track.type = 'ad';
                                resolve(track);
                                return;
                            }

                            const track = t.item;

                            resolve({
                                title: track.name,
                                artist: track.artists.reduce(
                                    (acc, a) =>
                                        acc + (acc ? ', ' : '') + a.name,
                                    ''
                                ),
                                duration: track.duration_ms,
                                cover: track.album.images
                                    ? track.album.images[0].url
                                    : undefined,
                                album: track.album.name,
                                discNumber: track.disc_number,
                                trackNumber: track.track_number,
                                albumArtist: track.album.artists.reduce(
                                    (acc, a) =>
                                        acc + (acc ? ', ' : '') + a.name,
                                    ''
                                ),
                                albumReleaseYear: parseInt(
                                    track.album.release_date.substring(0, 4),
                                    10
                                ),
                                isPremium,
                                kbps: isPremium ? 256 : 128,
                                directory:
                                    directoryName !== ''
                                        ? directoryName
                                        : undefined,
                                progress: t.progress_ms,
                                startTime: new Date(),
                            });
                        })
                        .catch((err) => {
                            console.warn(
                                'clipinc: could not retrieve remote track info, using local info',
                                err
                            );
                            resolve(getLocalTrackInfo());
                        });
                } else {
                    // No access token available, use local track info
                    console.warn('clipinc: no access token, using local track info');
                    resolve(getLocalTrackInfo());
                }
            })
            .catch((ex) => {
                // API not available (403, network error, etc.) - fall back to local info
                console.warn('clipinc: access token fetch failed, using local track info', ex);
                resolve(getLocalTrackInfo());
            });
    });

function getLocalTrackInfo() {
    let directoryName = '';

    const isPlaylistTrack = isTrackInPlayList();

    if (!isPlaylistTrack) {
        directoryName = getAlbumName();
    } else {
        directoryName = getPlayListName();
    }
    const isPremium = document.querySelector('.AdsContainer') === null;

    const titleEl = document.querySelector(
        '[data-testid="context-item-info-title"]'
    );
    const artistEl = document.querySelector(
        '[data-testid="context-item-info-subtitles"]'
    );
    const durationEl = document.querySelector(
        '[data-testid="playback-duration"]'
    );
    const coverEl = document.querySelector(
        'img[data-testid="cover-art-image"]'
    );

    const title = titleEl?.textContent || 'Unknown Title';
    const artist = artistEl?.textContent || 'Unknown Artist';
    const duration = durationEl?.textContent || '0:00';
    const cover = coverEl?.src || '';

    return {
        artist,
        title,
        duration: durationToMs(duration),
        cover,
        isPremium,
        kbps: isPremium ? 256 : 128,
        directory: directoryName !== '' ? directoryName : undefined,
        progress: 0,
        startTime: Date.now(),
    };
}

// parses duration to ms
function durationToMs(duration) {
    const times = duration.split(':');
    return (parseInt(times[0], 10) * 60 + parseInt(times[1], 10)) * 1000;
}

// retrieves a field from the cookies
function getCookie(key) {
    const cookies = document.cookie.split('; ');
    for (let i = 0, l = cookies.length; i < l; i++) {
        const c = cookies[i].split('=');
        if (c[0] === key) {
            return c[1];
        }
    }

    return '';
}

function getAccessToken() {
    return getCookie('wp_access_token');
}

// checks if playback is on the local device
function getIsLocalDevice() {
    const connectBar =
        document.querySelector('.ConnectBar') ||
        document.querySelector('[data-testid="connect-bar"]');

    return connectBar === null;
}

// get current volume from dom
function getVolume() {
    const v = JSON.parse(localStorage.getItem('playback') || '{"volume":1}').volume;
    return Math.max(0, Math.min(1, v * v * v));
}

// set volume via custom event (only works if inject.js setvolume listener is active)
// With the simplified inject.js, this is a no-op but we keep it for compatibility
function setVolume(volume) {
    const e = new CustomEvent('setvolume', {
        detail: { volume },
    });
    document.dispatchEvent(e);
}

// overwrite spotify volume control, to prevent gain change while recording
function hijackVolumeControl() {
    const hijackedVolumeBar = document.querySelector('.volume-bar--hijacked');

    if (hijackedVolumeBar !== null) {
        return;
    }

    const input = document.createElement('input');
    input.type = 'range';
    input.min = 0;
    input.max = 1;
    input.step = 0.01;
    input.value = JSON.parse(localStorage.getItem('playback') || '{"volume":1}').volume.toFixed(
        2
    );
    input.classList.add('slider');
    input.addEventListener('input', handlePlayerVolumeInput);

    const volumeBar = document.createElement('div');
    volumeBar.appendChild(input);
    volumeBar.classList.add('volume-bar', 'volume-bar--hijacked');

    // Try multiple selectors for the volume control (Spotify changes their UI frequently)
    const volumeBarElement =
        document.querySelector('.control-button[aria-describedby="volume-icon"]') ||
        document.querySelector('[data-testid="volume-bar"]') ||
        document.querySelector('.volume-bar');

    if (volumeBarElement) {
        volumeBarElement.parentNode.appendChild(volumeBar);
        volumeBarElement.style.display = 'none';
    } else {
        // Volume hijack is optional - recording still works without it
        console.warn('clipinc: could not hijack volume control, continuing without it');
    }
}

// remove custom volume control and show old one again
function releaseVolumeControl() {
    const volumeBar = document.querySelector('.volume-bar--hijacked');

    if (volumeBar !== null) {
        volumeBar.parentNode.removeChild(volumeBar);
    }

    const regularVolumeBar =
        document.querySelector('.control-button[aria-describedby="volume-icon"]') ||
        document.querySelector('[data-testid="volume-bar"]') ||
        document.querySelector('.volume-bar');

    if (regularVolumeBar) {
        regularVolumeBar.style.display = '';
    }
}

// ---- Message Listener ----
// Only register once to prevent double handling from manifest + programmatic injection

if (__clipincFirstLoad) {
    chrome.runtime.onMessage.addListener(
        ({ command, data }, sender, sendResponse) => {
            switch (command) {
                case 'prepareRecording': {
                    // Ensure clipinc-ready class is set (may not be if injected programmatically)
                    if (!document.querySelector('body.clipinc-ready')) {
                        document.body.classList.add('clipinc-ready');
                    }

                    const error = !getIsLocalDevice()
                        ? 'cannot record from remote device'
                        : undefined;
                    const oldVolume = getVolume();

                    if (!error) {
                        hijackVolumeControl();
                        setVolume(1);
                    }

                    sendResponse({ volume: oldVolume, error });
                    break;
                }
                case 'startRecording':
                    // Start DOM polling to detect track changes
                    startPolling();
                    break;
                case 'stopRecording':
                    // Stop DOM polling
                    stopPolling();
                    releaseVolumeControl();
                    if (data && data.volume !== undefined) {
                        setVolume(data.volume);
                    }
                    break;
            }
        }
    );
}

// ---- Player Control Functions ----

function play() {
    if (!isSpotifyPlaying()) {
        const playButton = document.querySelector(
            '[data-testid="control-button-playpause"]'
        );
        if (playButton) {
            playButton.click();
            return true;
        }
    }
    return false;
}

function pause() {
    const pauseButton = document.querySelector(
        '.player-controls__buttons>[data-testid="control-button-playpause"]'
    );

    if (pauseButton) {
        pauseButton.click();
        return true;
    }

    return false;
}

function skipBack() {
    const skipBackButton = document.querySelector(
        '.player-controls__buttons [data-testid="control-button-skip-back"]'
    );

    if (skipBackButton) {
        skipBackButton.click();
        return true;
    }

    return false;
}

// ---- Initialization ----

// Load inject.js to set the clipinc-ready class on the body
function initClipinc() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/inject.js');
    s.onload = function () {
        this.remove();

        // If player is already recording (e.g. page reload during recording),
        // resume polling and volume hijack
        chrome.storage.local.get('isRecording', ({ isRecording }) => {
            if (isRecording) {
                hijackVolumeControl();
                startPolling();
            }
        });
    };
    (document.head || document.documentElement).appendChild(s);
}

// Initialize as soon as content script loads (only once)
if (__clipincFirstLoad) {
    initClipinc();
}
