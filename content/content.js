// Guard against double injection (manifest + programmatic)
const __clipincFirstLoad = !window.__clipincLoaded;
window.__clipincLoaded = true;

// a title change this soon after a track started means Spotify updated the DOM
// after the play event, so it is a metadata update and not a new track
const TRACK_SETTLE_MS = 3000;
const POLL_INTERVAL_MS = 1000;

let trackTimeout;
let pollingInterval = null;
let sessionActive = false; // between startRecording and stopRecording
let trackOpen = false; // a track is being recorded (it may be paused)
let currentTrackKey = null;
let trackStartedAt = 0;
let trackSeq = 0; // invalidates late track info responses of previous tracks
let lastTrackInfo = null; // info of the track being recorded
let playingWithoutTrack = 0; // polls that saw playback without an open track
// a cancelled (skipped) track must not be restarted by polling as a fragment
let cancelledTrackKey = null;

// ---- Media events (dispatched by inject.js in the MAIN world) ----

document.addEventListener('clipinc:play', () => {
    if (!sessionActive) return;

    const key = getTrackKey();
    cancelledTrackKey = null;
    if (!trackOpen) {
        startTrack(key);
    } else if (
        key &&
        key !== currentTrackKey &&
        Date.now() - trackStartedAt > TRACK_SETTLE_MS
    ) {
        // switched to another track without an ended event
        finishTrack();
        startTrack(key);
    } else {
        chrome.runtime.sendMessage({ command: 'spotifyResume', data: {} });
    }
});

document.addEventListener('clipinc:pause', () => {
    if (sessionActive && trackOpen) {
        chrome.runtime.sendMessage({ command: 'spotifyPause', data: {} });
    }
});

document.addEventListener('clipinc:ended', () => {
    if (sessionActive && trackOpen) {
        finishTrack();
    }
});

// abort is dispatched when the user skips a track, the partial track is discarded
document.addEventListener('clipinc:abort', () => {
    if (sessionActive && trackOpen) {
        cancelTrack();
    }
});

// Spotify created a new media element, it has to play at full volume as well
document.addEventListener('clipinc:initplayer', () => {
    if (sessionActive) {
        setVolume(1, true);
    }
});

// ---- Track lifecycle ----

function startTrack(key) {
    trackSeq++;
    trackOpen = true;
    currentTrackKey = key;
    trackStartedAt = Date.now();
    lastTrackInfo = getLocalTrackInfo();
    console.debug('clipinc: start track', key);

    chrome.runtime.sendMessage({
        command: 'spotifyPlay',
        data: { track: lastTrackInfo },
    });

    clearTimeout(trackTimeout);
    trackTimeout = setTimeout(refreshTrackInfo, 1000);
}

// reads the track info again, late answers for a previous track are ignored
function refreshTrackInfo() {
    const seq = trackSeq;
    getTrackInfo().then((track) => {
        if (seq !== trackSeq) return;
        updateTrackInfo(track);
    });
}

function updateTrackInfo(track) {
    lastTrackInfo = track;
    chrome.runtime.sendMessage({
        command: 'spotifyUpdateTrack',
        data: { track },
    });
}

// sends the info of the finished track along, so the service worker does not
// have to read it from storage where the next spotifyPlay overwrites it
function finishTrack() {
    console.debug('clipinc: finish track', currentTrackKey);
    clearTimeout(trackTimeout);
    trackSeq++;
    trackOpen = false;
    chrome.runtime.sendMessage({
        command: 'spotifyEnded',
        data: { track: lastTrackInfo },
    });
}

function cancelTrack() {
    console.debug('clipinc: cancel track', currentTrackKey);
    cancelledTrackKey = currentTrackKey;
    clearTimeout(trackTimeout);
    trackSeq++;
    trackOpen = false;
    chrome.runtime.sendMessage({ command: 'spotifyAbort', data: {} });
}

// ---- Session ----

function startSession() {
    sessionActive = true;
    trackOpen = false;
    currentTrackKey = null;
    playingWithoutTrack = 0;
    setVolume(1, true);

    // restart the current track so the first file is complete,
    // the track is opened by the play event
    pause();
    skipBack();
    setTimeout(play, 500);

    clearInterval(pollingInterval);
    pollingInterval = setInterval(pollSpotifyState, POLL_INTERVAL_MS);
}

function stopSession(volume) {
    sessionActive = false;
    trackOpen = false;
    clearTimeout(trackTimeout);
    trackSeq++;
    clearInterval(pollingInterval);
    pollingInterval = null;

    setVolume(volume !== undefined ? volume : 1, false);
}

// Fallback for track changes without media events (e.g. gapless playback
// via MediaSource, or the media element was not hooked)
function pollSpotifyState() {
    if (!sessionActive || !isSpotifyPlaying()) {
        playingWithoutTrack = 0;
        return;
    }

    const key = getTrackKey();
    if (!key) return;

    if (!trackOpen) {
        // the rest of a cancelled track would only be a fragment
        if (key === cancelledTrackKey) {
            playingWithoutTrack = 0;
            return;
        }
        // a play event normally opens the track immediately,
        // wait for a second poll before falling back
        if (++playingWithoutTrack >= 2) {
            console.debug('clipinc: playback without play event, start track');
            startTrack(key);
        }
        return;
    }
    playingWithoutTrack = 0;

    if (key === currentTrackKey) return;

    if (Date.now() - trackStartedAt < TRACK_SETTLE_MS) {
        // the play event came before Spotify updated the DOM
        currentTrackKey = key;
        refreshTrackInfo();
    } else {
        console.debug('clipinc: track change detected by polling');
        finishTrack();
        startTrack(key);
    }
}

function getTrackKey() {
    const title = getCurrentTitle();
    const artist = getCurrentArtist();
    if (!title) return null;
    return artist ? `${title}|||${artist}` : title;
}

/**
 * Checks if Spotify is currently playing by inspecting the play/pause button's aria-label.
 * aria-label "Pause" = currently playing (button would pause if clicked)
 * aria-label "Play" = currently paused (button would play if clicked)
 * Confirmed working from user logs: btn aria-label: Pause / Play
 */
function isSpotifyPlaying() {
    const btn = document.querySelector(
        '[data-testid="control-button-playpause"]',
    );
    if (!btn) return false;

    const label = (btn.getAttribute('aria-label') || '').toLowerCase();

    // "Pause" or "Pausieren" (DE) → currently playing
    // Note: "pausieren" does NOT contain "pause" (it's paus-i-e-ren), so we check for "paus"
    if (label.includes('paus')) return true;
    // "Play" or "Abspielen" (DE) or "Wiedergabe" (DE) → currently paused
    if (
        label.includes('play') ||
        label.includes('abspielen') ||
        label.includes('wiedergabe')
    )
        return false;

    // Fallback: check SVG path
    const playIconPath = btn.querySelector('path[d*="M3 1.713"]');
    if (playIconPath) return false;

    return true;
}

function getCurrentTitle() {
    const el = document.querySelector(
        '[data-testid="context-item-info-title"]',
    );
    return el?.textContent || null;
}

function getCurrentArtist() {
    const el = document.querySelector(
        '[data-testid="context-item-info-subtitles"]',
    );
    return el?.textContent || null;
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
        'div[data-testid="playlist-tracklist"]',
    );
    return trackList?.getAttribute('aria-label') || '';
}

/**
 * Checks if the current playing Track is in a Playlist
 * @returns {boolean}
 */
function isTrackInPlayList() {
    const playlist = document.querySelector(
        'div[data-testid="playlist-tracklist"]',
    );
    return Boolean(playlist);
}

// Track info from the DOM, completed with album, album artist, track number
// and release year from Spotify's embed pages (the regular pages carry no
// meta tags for browsers, the Web API answers 403).
async function getTrackInfo() {
    const track = getLocalTrackInfo();
    const { trackId, albumId } = getCurrentIds();

    try {
        if (albumId) {
            const album = await fetchAlbumMeta(albumId);
            track.album = album.album;
            track.albumArtist = album.albumArtist;
            track.albumReleaseYear = album.albumReleaseYear;

            const index = album.trackUris.indexOf(`spotify:track:${trackId}`);
            if (index >= 0) {
                track.trackNumber = String(index + 1);
            }
        }

        if (!track.albumReleaseYear && trackId) {
            const entity = await fetchEmbedEntity('track', trackId);
            track.albumReleaseYear = getReleaseYear(entity);
            if (!track.albumReleaseYear) {
                console.debug(
                    'clipinc: no release year, track entity keys',
                    Object.keys(entity || {}),
                );
            }
        }
    } catch (err) {
        console.warn('clipinc: could not read album info', err);
    }

    console.debug('clipinc: track info', track);
    return track;
}

// ids of the playing track and its album from the links of the now playing
// widget, e.g. /album/<albumId>?uri=spotify:track:<trackId>
function getCurrentIds() {
    let trackId = null;
    let albumId = null;

    const links = document.querySelectorAll(
        '[data-testid="context-item-info-title"] a, a[data-testid="context-link"]',
    );
    for (const link of links) {
        const url = new URL(link.href, window.location.origin);
        albumId = albumId || url.pathname.match(/\/album\/(\w+)/)?.[1];
        trackId =
            trackId ||
            (url.searchParams.get('uri') || '').match(
                /^spotify:track:(\w+)$/,
            )?.[1] ||
            url.pathname.match(/\/track\/(\w+)/)?.[1];
    }

    return { trackId, albumId };
}

const albumCache = new Map();

function fetchAlbumMeta(albumId) {
    if (!albumCache.has(albumId)) {
        const promise = fetchEmbedEntity('album', albumId).then((entity) => ({
            album: entity?.name || undefined,
            albumArtist: entity?.subtitle || undefined,
            albumReleaseYear: getReleaseYear(entity),
            trackUris: (entity?.trackList || []).map((t) => t.uri),
        }));
        // a failed request is retried with the next track
        promise.catch(() => albumCache.delete(albumId));
        albumCache.set(albumId, promise);
    }
    return albumCache.get(albumId);
}

// The embed page (open.spotify.com/embed/<type>/<id>) is rendered with
// Next.js, its __NEXT_DATA__ script holds the entity as JSON.
async function fetchEmbedEntity(type, id) {
    const res = await fetch(`/embed/${type}/${id}`, { credentials: 'omit' });
    if (!res.ok) {
        throw new Error(`embed ${type} returned ${res.status}`);
    }

    const html = await res.text();
    const json = html.match(
        /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s,
    )?.[1];
    if (!json) {
        throw new Error(`embed ${type} has no __NEXT_DATA__`);
    }
    return JSON.parse(json).props?.pageProps?.state?.data?.entity || null;
}

// releaseDate is either an ISO string or { isoString }, may be null
function getReleaseYear(entity) {
    const date = entity?.releaseDate;
    const value = typeof date === 'string' ? date : date?.isoString;
    return parseInt(String(value || '').substring(0, 4), 10) || undefined;
}

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
        '[data-testid="context-item-info-title"]',
    );
    const artistEl = document.querySelector(
        '[data-testid="context-item-info-subtitles"]',
    );
    const durationEl = document.querySelector(
        '[data-testid="playback-duration"]',
    );
    const coverEl = document.querySelector(
        'img[data-testid="cover-art-image"]',
    );

    const title = titleEl?.textContent || 'Unknown Title';
    const artist = artistEl?.textContent || 'Unknown Artist';
    const duration = durationEl?.textContent || '0:00';
    const coverSrc = coverEl?.src || '';
    const coverUrls = getCoverUrls(coverSrc);
    // the popup shows the 640px variant, it exists for every album
    const cover = coverUrls.length === 3 ? coverUrls[1] : coverSrc;

    return {
        artist,
        title,
        duration: durationToMs(duration),
        cover,
        coverUrls,
        isPremium,
        kbps: isPremium ? 256 : 128,
        directory: directoryName !== '' ? directoryName : undefined,
        progress: 0,
        startTime: Date.now(),
    };
}

// The player bar shows a 64px cover, the now playing view 300px. Spotify's
// CDN encodes the size in the image id (album covers: ab67616d + 00004851 =
// 64px, 00001e02 = 300px, 0000b273 = 640px, 000082c1 = original size).
// Returns the urls from best to worst, the worker uses the first that loads.
function getCoverUrls(src) {
    const match = src.match(/^(.*\/image\/ab67616d)(00004851|00001e02)(.*)$/);
    if (!match) {
        return src ? [src] : [];
    }

    const [, prefix, , id] = match;
    return [`${prefix}000082c1${id}`, `${prefix}0000b273${id}`, src];
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
    const v = JSON.parse(
        localStorage.getItem('playback') || '{"volume":1}',
    ).volume;
    return Math.max(0, Math.min(1, v * v * v));
}

// set the volume of Spotify's media element via inject.js,
// lock = true keeps it fixed while recording
function setVolume(volume, lock) {
    const e = new CustomEvent('clipinc:setvolume', {
        detail: JSON.stringify({ volume, lock }),
    });
    document.dispatchEvent(e);
}

// ---- Message Listener ----
// Only register once to prevent double handling from manifest + programmatic injection

if (__clipincFirstLoad) {
    chrome.runtime.onMessage.addListener(
        ({ command, data }, sender, sendResponse) => {
            switch (command) {
                case 'prepareRecording': {
                    const error = !getIsLocalDevice()
                        ? 'cannot record from remote device'
                        : undefined;
                    const oldVolume = getVolume();

                    if (!error) {
                        setVolume(1, true);
                    }

                    sendResponse({ volume: oldVolume, error });
                    break;
                }
                case 'startRecording':
                    startSession();
                    break;
                case 'stopRecording':
                    stopSession(data && data.volume);
                    break;
            }
        },
    );
}

// ---- Player Control Functions ----

function play() {
    if (isSpotifyPlaying()) return false;

    const playButton = document.querySelector(
        '[data-testid="control-button-playpause"]',
    );
    if (playButton) {
        playButton.click();
        return true;
    }
    return false;
}

function pause() {
    if (!isSpotifyPlaying()) return false;

    const pauseButton = document.querySelector(
        '[data-testid="control-button-playpause"]',
    );
    if (pauseButton) {
        pauseButton.click();
        return true;
    }
    return false;
}

function skipBack() {
    const skipBackButton = document.querySelector(
        '[data-testid="control-button-skip-back"]',
    );

    if (skipBackButton) {
        skipBackButton.click();
        return true;
    }

    return false;
}

// ---- Initialization ----

if (__clipincFirstLoad) {
    document.body.classList.add('clipinc-ready');
}
