// Runs in the page's MAIN world at document_start (see manifest.json), so it can
// see Spotify's media element. Bridges media events to the content script via
// CustomEvents on document (the DOM is shared between worlds).

(function () {
    if (window.__clipincInjected) {
        return;
    }
    window.__clipincInjected = true;

    const EVENTS = ['play', 'pause', 'ended', 'abort', 'seeking'];
    const hooked = new WeakSet();
    let targetVolume = null;

    function dispatchToDocument(event) {
        // the media element dispatches pause before ended when a track ends,
        // drop that pause so the track can be finished instead of paused
        if (event.target.ended && event.type !== 'ended') {
            return;
        }

        document.dispatchEvent(new CustomEvent(`clipinc:${event.type}`));
    }

    function hookElement(element) {
        if (hooked.has(element)) {
            return;
        }
        hooked.add(element);
        window._svp = element;

        EVENTS.forEach((type) =>
            element.addEventListener(type, dispatchToDocument),
        );

        // while recording, Spotify must not change the gain of the captured signal
        element.addEventListener('volumechange', () => {
            if (targetVolume !== null && element.volume !== targetVolume) {
                element.volume = targetVolume;
            }
        });

        if (targetVolume !== null) {
            element.volume = targetVolume;
        }

        document.dispatchEvent(new CustomEvent('clipinc:initplayer'));
    }

    // catch elements created after this script ran
    const createElement = document.createElement;
    document.createElement = function (tag, ...args) {
        const element = createElement.call(document, tag, ...args);
        const name = String(tag).toLowerCase();
        if (name === 'audio' || name === 'video') {
            hookElement(element);
        }
        return element;
    };

    // catch elements created before this script ran (e.g. programmatic injection
    // after an extension update) or created via `new Audio()` / innerHTML
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
        if (!hooked.has(this)) {
            hookElement(this);
            // the play event of this call is dispatched after we attached the listener
        }
        return play.apply(this, args);
    };

    // detail is a JSON string, objects do not reliably cross the world boundary.
    // lock = true keeps the volume fixed until the next unlocked setvolume
    document.addEventListener('clipinc:setvolume', (event) => {
        const { volume, lock } = JSON.parse(event.detail);
        targetVolume = lock ? volume : null;
        if (window._svp) {
            window._svp.volume = volume;
        }
    });
})();
