# clipinc – Spotify-Songs als MP3 aufnehmen

clipinc ist eine Browser-Erweiterung für Chrome und Edge. Sie nimmt Songs aus
dem Spotify-Webplayer auf, während du sie hörst, und speichert sie als MP3 mit
Titel, Interpret, Album und Cover in deinem Download-Ordner.

clipinc wurde ursprünglich von Tobit Software entwickelt und ist nicht mehr im
Chrome Web Store verfügbar. Diese Version ist auf das aktuelle
Erweiterungsformat (Manifest V3) umgestellt und funktioniert wieder mit dem
aktuellen Spotify-Webplayer.

Download: https://github.com/madex/clipinc/releases/latest

## Installation

1. `clipinc-vX.Y.Z.zip` aus dem neuesten Release herunterladen
2. Die ZIP-Datei in einen Ordner entpacken, der bestehen bleibt (Chrome lädt die
   Erweiterung von dort, den Ordner also nicht löschen)
3. In Chrome `chrome://extensions` öffnen (in Edge `edge://extensions`)
4. Oben rechts den **Entwicklermodus** einschalten
5. **Entpackte Erweiterung laden** klicken und den entpackten Ordner auswählen
6. Bereits geöffnete Spotify-Tabs neu laden

## Benutzung

1. Den Spotify-Webplayer öffnen (https://open.spotify.com) und eine Playlist
   oder ein Album starten
2. Auf das clipinc-Symbol klicken und die Aufnahme einschalten
3. Der aktuelle Song startet von vorn. Jeder Song, der bis zum Ende läuft,
   landet als MP3 in `Downloads/clipinc/<Playlist oder Album>/`

Gut zu wissen:

-   Während der Aufnahme ist der Tab stumm.
-   Übersprungene Songs werden verworfen, Pausen werden nicht mit aufgenommen.
-   Die Wiedergabe muss auf diesem Gerät laufen, nicht per Spotify Connect auf
    einem anderen Gerät.
-   Chrome zeigt beim Start eventuell einen Hinweis zu Erweiterungen im
    Entwicklermodus an, der kann geschlossen werden.

## Update

Die neue ZIP-Datei in denselben Ordner entpacken (alte Dateien ersetzen) und in
`chrome://extensions` bei clipinc auf das Neu-laden-Symbol klicken.

## Hinweis

Aufnahmen nur für den privaten Gebrauch. Die Nutzungsbedingungen von Spotify
untersagen das Mitschneiden von Inhalten, die Nutzung erfolgt auf eigene
Verantwortung.
