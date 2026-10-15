# Clipinc MV3 Migration — Analyse

## Architektur-Übersicht

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                                 │
│                                                                 │
│  ┌──────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │  Popup   │    │  Service Worker  │    │  Content Script  │  │
│  │ (React)  │◄──►│  (Orchestrator)  │◄──►│  (Spotify DOM)   │  │
│  └──────────┘    └────────┬─────────┘    └──────────────────┘  │
│                           │                                     │
│                           ▼                                     │
│                  ┌──────────────────┐                           │
│                  │ Offscreen Doc    │                           │
│                  │                  │                           │
│                  │  ┌────────────┐  │                           │
│                  │  │AudioContext│  │                           │
│                  │  │  (Capture) │  │                           │
│                  │  └─────┬──────┘  │                           │
│                  │        │         │                           │
│                  │  ┌─────▼──────┐  │                           │
│                  │  │  Recorder  │  │                           │
│                  │  │(ScriptProc)│  │                           │
│                  │  └─────┬──────┘  │                           │
│                  │        │         │                           │
│                  │  ┌─────▼──────┐  │                           │
│                  │  │ Mp3Worker  │  │                           │
│                  │  │ (WebWorker)│  │                           │
│                  │  └─────┬──────┘  │                           │
│                  │        │         │                           │
│                  │  chrome.downloads│                           │
│                  └──────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

### Komponenten

| Komponente | Datei | Rolle |
|---|---|---|
| **Popup** | `popup/App.jsx`, `popup/recording-screen/Recorder.jsx` | UI mit Start/Stop-Switch, Track-Anzeige, Download-Counter |
| **Service Worker** | `service-worker/index.js` | Orchestrator: Tab Capture, Message Routing, Offscreen Lifecycle |
| **Content Script** | `content/content.js` | DOM-Polling auf Spotify, Track-Erkennung, Volume-Hijacking |
| **Inject Script** | `content/inject.js` | Setzt `clipinc-ready` Klasse auf `<body>` |
| **Offscreen Document** | `offscreen/offscreen.js` | Audio-Capture, Recorder-Instanz, Download via Blob URL |
| **Recorder** | `background-page/recorder.js` | AudioContext → ScriptProcessorNode → Worker-Pipeline |
| **Mp3Worker** | `background-page/Mp3Worker.js` | LAME-Encoding + ID3-Tagging im Web Worker |
| **Mp3Encoder** | `background-page/encoders/Mp3Encoder.min.js` | Emscripten-kompilierter LAME-Encoder (asm.js) |
| **ID3Writer** | `background-page/encoders/browser-id3-writer.js` | ID3v2.3-Tag-Writer |

---

## Message-Flow

### Start der Aufnahme

```
Popup                    Service Worker              Content Script           Offscreen
  │                           │                           │                       │
  │ startCapture ────────────►│                           │                       │
  │                           │ prepareRecording ────────►│                       │
  │                           │                           │ (hijackVolume,        │
  │                           │◄──── {volume, error} ─────│  setVolume(1))        │
  │                           │                           │                       │
  │                           │ tabCapture.getMediaStreamId()                     │
  │                           │ ensureOffscreenDocument()                         │
  │                           │                           │                       │
  │                           │ offscreen:startCapture ──────────────────────────►│
  │                           │                           │    getUserMedia()     │
  │                           │                           │    new Recorder()     │
  │                           │                           │    Audio playback     │
  │                           │◄──── {success: true} ─────────────────────────────│
  │                           │                           │                       │
  │                           │ startRecording ──────────►│                       │
  │                           │                           │ startPolling()        │
  │◄── {success: true}  ──────│                           │                       │
```

### Track-Erkennung (DOM-Polling)

```
Content Script (jede Sekunde)                Service Worker              Offscreen
  │                                               │                          │
  │ pollSpotifyState()                            │                          │
  │ - isSpotifyPlaying() [aria-label]             │                          │
  │ - getCurrentTitle() [data-testid]             │                          │
  │ - getCurrentArtist() [data-testid]            │                          │
  │                                               │                          │
  │ [Track-Wechsel erkannt]                       │                          │
  │                                               │                          │
  │ spotifyEnded ────────────────────────────────►│                          │
  │                                               │ storage.get('track')     │
  │                                               │ offscreen:spotifyEnded ─►│
  │                                               │                          │ finishRecording()
  │                                               │                          │ → Mp3Worker: finish
  │                                               │                          │ → Encoding + ID3
  │                                               │                          │ → chrome.downloads
  │                                               │◄─ offscreen:downloadComplete
  │                                               │ notification + counter   │
  │                                               │                          │
  │ spotifyPlay ─────────────────────────────────►│                          │
  │                                               │ storage.set({track})     │
  │                                               │ offscreen:spotifyPlay ──►│
  │                                               │                          │ startRecording()
  │ [1s später: spotifyUpdateTrack] ─────────────►│                          │
  │                                               │ storage.set({track})     │
```

### Stop der Aufnahme

```
Popup                    Service Worker              Content Script           Offscreen
  │                           │                           │                       │
  │ stopCapture ─────────────►│                           │                       │
  │                           │ offscreen:stopCapture ───────────────────────────►│
  │                           │                           │    cancelRecording()  │
  │                           │                           │    audioElement.pause │
  │                           │                           │    stream.stop()      │
  │                           │                           │                       │
  │                           │ stopRecording ───────────►│                       │
  │                           │                           │ stopPolling()         │
  │                           │                           │ releaseVolumeControl  │
  │                           │                           │ setVolume(old)        │
  │                           │                           │                       │
  │                           │ resetStorage()            │                       │
  │                           │ closeOffscreenDocument()  │                       │
```

---

## Identifizierte Issues

### Kritisch (Recording funktioniert nicht)

| ID | Issue | Datei | Status |
|---|---|---|---|
| **C1** | Cover-Fetch ohne Error-Handling — wenn `track.cover` leer oder Fetch fehlschlägt, wird `complete` nie gesendet, Aufnahme hängt für immer | `Mp3Worker.js` | ✅ Behoben |
| **C2** | `audioElement.play()` ohne Error-Handling — Autoplay-Policy blockiert, User hört keinen Ton | `offscreen.js` | ✅ Behoben |

### Hoch

| ID | Issue | Datei | Status |
|---|---|---|---|
| **H1** | Content Script nicht erreichbar nach Extension-Update — `sendMessage` wirft Error | `service-worker/index.js` | ✅ Behoben (programmatische Injektion als Fallback) |
| **H2** | `spotifyPause` stoppte gesamte Recording-Session statt nur den aktuellen Track | `service-worker/index.js` | ✅ Behoben (Pause wird ignoriert, kontinuierliche Aufnahme) |
| **H3** | `isSpotifyPlaying()` mit fragiler SVG-Path-Erkennung — `d`-Attribut ändert sich bei Spotify-Updates | `content/content.js` | ✅ Behoben (aria-label statt SVG) |
| **H4** | Doppelte Content-Script-Injektion (Manifest + programmatisch) — doppeltes Polling, doppelte Message-Listener | `content/content.js` | ✅ Behoben (Guard `window.__clipincLoaded`) |
| **H5** | `prepareRecording` rief `window.location.reload()` auf statt `sendResponse()` — Endlosschleife | `content/content.js` | ✅ Behoben |

### Mittel

| ID | Issue | Datei | Status |
|---|---|---|---|
| **M1** | Pause/Resume-Flapping — Progress-Bar-Methode zur Play-Erkennung liefert jeden 2. Tick `false` | `content/content.js` | ✅ Behoben (nur Track-Wechsel, keine Pause-Erkennung) |
| **M2** | `ScriptProcessorNode` ist deprecated — sollte langfristig durch `AudioWorkletNode` ersetzt werden | `recorder.js` | ⚠️ Funktional, aber zukunftsgefährdet |
| **M3** | Popup `onMessage`-Listener wird bei jedem Re-Render neu registriert (fehlende Cleanup-Funktion) | `popup/App.jsx` | ⚠️ Bekannt, niedrige Priorität |

### Niedrig

| ID | Issue | Datei | Status |
|---|---|---|---|
| **L1** | asm.js-Warnung im Console-Log (Mp3Encoder) — kosmetisch, kein Funktionsproblem | `Mp3Encoder.min.js` | ℹ️ Bekannt, ignorierbar |
| **L2** | Volume-Hijack findet Spotify-Slider nicht immer (UI-Änderungen) — Recording funktioniert trotzdem | `content/content.js` | ℹ️ Optional, graceful degradation |
| **L3** | `isAlbumTrack()` gibt immer `false` zurück — Selektor `.cover-art-playback playing` existiert nicht | `content/content.js` | ℹ️ Unused, kein Effekt |

---

## Bekannte Limitierungen

### Spotify API 403
Die Spotify Web API (`/v1/me/player`) gibt oft `403 Forbidden` zurück. Das ist **kein Bug**, sondern eine Spotify-Einschränkung. Der Code fällt korrekt auf `getLocalTrackInfo()` zurück, das die Track-Infos aus dem DOM liest.

### asm.js Warnung
```
Compiling asm.js module without first running it...
```
Dies kommt vom Emscripten-kompilierten LAME-Encoder. Es ist eine **kosmetische Warnung** — der Encoder funktioniert trotzdem korrekt. Moderne Browser ignorieren asm.js-Annotationen und JIT-kompilieren den Code normal.

### Continuous Recording Model
Die Aufnahme läuft **kontinuierlich** — auch während Spotify pausiert ist. Dadurch enthalten die MP3-Dateien möglicherweise Stille am Anfang oder Ende, wenn der User zwischen Songs pausiert hat. Dies ist ein bewusster Trade-off, um die Pause/Resume-Flapping-Probleme zu vermeiden.

### ScriptProcessorNode Deprecation
`ScriptProcessorNode` ist offiziell deprecated zugunsten von `AudioWorkletNode`. Chrome unterstützt es aktuell noch, aber langfristig sollte die Recorder-Klasse auf AudioWorklet migriert werden. Dies erfordert eine separate `.js`-Datei für den Worklet-Processor.

---

## Build-System

### Webpack Multi-Config

```
webpack.config.js → 4 Build-Targets:

1. popup     → dist/popup/      (React UI)
2. content   → dist/content/    (Content Script + Inject + CSS)
3. serviceWorker → dist/service-worker/ (+ manifest.json, assets, locales)
4. offscreen → dist/offscreen/  (+ encoders/)
```

### Build-Befehl

```bash
npm run build
```

### Verzeichnis-Struktur (dist/)

```
dist/
├── manifest.json
├── assets/images/          # Icons
├── _locales/de/            # Lokalisierung
├── popup/
│   ├── index.html
│   ├── popup.js
│   └── main.css
├── content/
│   ├── content.js
│   ├── inject.js
│   └── slider.css
├── service-worker/
│   └── index.js
└── offscreen/
    ├── index.html
    ├── offscreen.js
    ├── 869.js              # Mp3Worker (chunked)
    └── encoders/
        ├── Mp3Encoder.min.js
        ├── Mp3Encoder.min.js.mem
        └── browser-id3-writer.js
```

---

## Debugging-Checkliste

### Aufnahme starten
1. Spotify-Tab öffnen, Song abspielen
2. Clipinc-Popup öffnen, Switch aktivieren
3. Console prüfen (Service Worker: `chrome://extensions` → Inspect):
   - `SW: prepareRecording OK, volume: ...`
   - `Offscreen: audio playback started via ...`
4. Console prüfen (Spotify-Tab: F12):
   - `clipinc: startPolling` (genau EINMAL!)
   - `clipinc: poll state - playing: true ...`

### Track-Wechsel / Download
5. Song wechseln lassen oder manuell skippen
6. Console prüfen (Spotify-Tab):
   - `clipinc: track changed → ending previous track`
   - `clipinc: new track → start recording: [Titel] - [Artist]`
7. Console prüfen (Service Worker):
   - `SW: spotifyEnded received`
   - `SW: download complete for [Titel]`
8. Downloads-Ordner prüfen: `clipinc/[Artist] - [Titel].mp3`

### Häufige Probleme
- **Kein `startPolling`**: Content Script nicht geladen → Extension neu laden
- **`startPolling` doppelt**: Doppelte Injektion → Guard prüfen
- **`playing: false` obwohl Song läuft**: aria-label-Sprache nicht erkannt → Sprach-Strings erweitern
- **Kein Download nach Track-Wechsel**: Mp3Worker hängt → Console auf Fehler prüfen
- **Kein Ton**: Autoplay blockiert → Console-Warnung prüfen, AudioContext-Fallback aktiv?
