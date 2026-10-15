<h1 align="center"><a href="https://github.com/madex/clipinc" target="_blank">clipinc</a></h1>

<p align="center">
    <strong>Records Spotify songs in your browser as you listen to them</strong>
</p>

<p align="center">
    <a href="https://github.com/madex/clipinc/releases/latest" target="_blank">
        <img
            alt="Latest release"
            src="https://img.shields.io/github/v/release/madex/clipinc?style=for-the-badge&color=%2310B981&labelColor=%2327272A"
        />
    </a>
    <a href="https://github.com/madex/clipinc/blob/main/LICENSE" target="_blank">
        <img
            alt="MIT License"
            src="https://img.shields.io/github/license/madex/clipinc?style=for-the-badge&color=%236366F1&labelColor=%2327272A"
        />
    </a>
</p>

<p align="center">
    <a href="#-installation"><b>Installation</b></a>
    <span>  •  </span>
    <a href="#-usage"><b>Usage</b></a>
    <span>  •  </span>
    <a href="#-local-development"><b>Local Development</b></a>
</p>

---

This browser extension records Spotify songs as you listen to them and saves
them as MP3 files (with title, artist, album and cover) to your default download
directory.

clipinc was originally developed by
[Tobit Software](https://github.com/TobitSoftware/clipinc) and is no longer
available in the Chrome Web Store. This fork keeps it working: it is ported to
Manifest V3 and fixes recording with the current Spotify web player.

## ❯ Installation

The extension is not in the Chrome Web Store, it is installed from a release:

1. Download `clipinc-vX.Y.Z.zip` from the
   [latest release](https://github.com/madex/clipinc/releases/latest)
2. Unpack the zip into a folder you keep (Chrome loads the extension from there,
   do not delete it)
3. Open `chrome://extensions` (or `edge://extensions`)
4. Activate the **developer mode** (toggle in the top right corner)
5. Click **Load unpacked** and select the unpacked folder
6. Reload open Spotify tabs

**Update:** unpack the new release into the same folder (replace the old files)
and click the reload icon of clipinc in `chrome://extensions`.

## ❯ Usage

1. Open the [Spotify web player](https://open.spotify.com) and start a playlist
   or album
2. Click the clipinc icon and switch the recording on
3. The current song starts from the beginning, every song that has been played
   to the end is saved to `Downloads/clipinc/<playlist or album>/`

The tab is muted while recording. Skipped songs are discarded, pauses are not
recorded. Playback has to run on this device (not via Spotify Connect).

## ❯ Local Development

1. Clone repository
2. Install the dependencies by running `npm i`
3. Build a development version by running `npm run dev-build`
4. Open `chrome://extensions` or `edge://extensions`
5. Activate developer mode
6. Load the `dist/` directory as an unpacked extension

After performing changes you have to run the `npm run dev-build` command again
and reload the extension to pick up your changes.

## ❯ Contribute

If you think you have any ideas that could benefit the project, feel free to
create an issue or pull request!

Check out our [contribution guide](./CONTRIBUTING.md) on how to initialize the
project on your machine, fix bugs and publish a new version.
