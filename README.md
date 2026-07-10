# VR Video Streamer 🎥📱

Watch any web video in a Google Cardboard headset — with one click.

You browse to a video on your computer, click a bookmarklet, and seconds later
it's playing on your phone in side-by-side VR with gyroscope head tracking and
lens-corrected rendering. No app to install, no downloading videos, no copying
links to your phone.

```
Browser (computer) ──bookmarklet──▶ local server ──yt-dlp + proxy──▶ video site
                                        │                               ▲
                                        ▼ Wi-Fi (HTTPS + WebSocket)     │ VPN (if any)
                                 phone browser (VR player)              │ lives here
```

## Platforms

| Piece | Works on |
|---|---|
| Server | **macOS** (tested; Apple hardware transcoding), **Linux / Windows** (NVIDIA/Intel hardware encoders auto-detected, software fallback) |
| Phone | **iPhone** (Safari, tested) and **Android** (Chrome) — it's just a web page |
| Sending browser | Anything that can hold a bookmarklet (Chrome, Edge, Firefox, Safari…) |

The transcode encoder is picked automatically at startup: Apple VideoToolbox
on macOS, NVENC/QuickSync where available, x264 software otherwise.

## Why this exists

Watching VR (360°/180°/3D) web videos in a phone-based headset normally means
downloading the file, transferring it to the phone, and opening it in a player
app. This tool collapses all of that into one click — and adds a property that
downloaders can't offer: **the phone never contacts the video site**. The
server resolves and fetches everything, so a video that needs your computer's
VPN, login session, or region streams to the phone with none of that
configured on it.

## Features

- **One-click send** from any page via a bookmarklet, or paste a URL — or a
  **local file path** — into the remote page
- **Works on ~1,800 sites** (everything [yt-dlp](https://github.com/yt-dlp/yt-dlp)
  supports), plus direct video links, plus an HTML-sniffing fallback for
  unknown sites
- **VPN / session passthrough**: extraction uses your browser cookies and all
  bytes flow through the server, so the phone needs no VPN, account, or region
- **Cardboard VR player in the phone's browser** — no app store: stereo
  rendering with **barrel lens correction**, optics-matched field of view,
  real inter-eye separation, gyroscope head tracking, 360° / 180° / flat
  projections, mono / side-by-side / top-bottom 3D layouts
- **Hands-free gaze controls in the headset**: look at a button and hold for
  1.5s to select — play/pause, ±5s, recenter, and a gaze-seekable timeline
- **Two viewing modes**: Headset (dual lens-corrected eyes) and Handheld
  (fullscreen magic window). Settings persist
- **Automatic compatibility transcoding**: AV1/VP9 video is transcoded in
  hardware and delivered as HLS; wrong-container files (MKV, WebM) are
  losslessly remuxed; oversized single-rendition videos are downscaled to
  your chosen quality
- **Dynamic quality menu** with the renditions each video actually offers
  (2K default ceiling, 4K available; `MAX_HEIGHT`/`DEFAULT_HEIGHT` env vars)
- **Smooth playback**: read-ahead chunk caching, HLS segment prefetching, and
  self-healing streams (expired/throttled CDN links re-extract automatically)
- **Full remote control** from the computer: live seek bar with **hover frame
  previews**, play/pause, skips, quality — synced over WebSocket

## Requirements

- Node.js ≥ 18, [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ffmpeg](https://ffmpeg.org)
- A phone with a gyroscope and a modern browser (iPhone: Safari, iOS 16.4+
  for in-browser fullscreen — older iOS works via "Add to Home Screen";
  Android: Chrome)
- Both devices on the same Wi-Fi network

## Setup (one time, ~5 minutes)

### Computer

```bash
# macOS: brew install node yt-dlp ffmpeg
# Debian/Ubuntu: sudo apt install nodejs npm ffmpeg && pip install yt-dlp
# Windows: winget install OpenJS.NodeJS Gyan.FFmpeg yt-dlp.yt-dlp (then run setup steps manually or via Git Bash)
git clone https://github.com/GhanibhutiGogoi/vr-video-streamer.git
cd vr-video-streamer
./setup.sh          # installs deps + generates a self-signed certificate,
                    # then prints the trust command for your OS
npm start
```

The server prints its addresses. Open `https://<server-ip>:8443/remote` in
your browser and drag the **▶ Send to VR** button to the bookmarks bar.

> **Why a certificate?** Phones only expose the gyroscope to HTTPS pages, so
> the local server must speak TLS, and both devices must trust its self-signed
> cert. It never leaves your machines.

### Phone (same Wi-Fi)

1. Open `http://<server-ip>:8080` in the phone's browser — it walks you
   through downloading and trusting the certificate (steps shown for both
   iPhone and Android).
2. Open `https://<server-ip>:8443` — that's the VR player. Tap **Enter VR**,
   allow motion access, slide the phone into the headset.

## Daily use

1. `npm start` on the computer (leave it running).
2. Open the player on the phone, tap **Enter VR**, mount it in the headset.
3. Browse to any video on the computer → click **▶ Send to VR**.

**In-headset (hands-free):** glance right at the **☰ Menu** pill and hold your
gaze — a ring fills and the control panel opens: timeline (gaze along it,
hold to seek), ⏯, ±5s, recenter, close. Single tap = 2D menu · double tap =
play/pause. Pick the projection (360°/180°/flat) matching the video once —
settings are remembered.

**From the computer:** the `/remote` page is a live remote — seek bar with
hover frame previews, play/pause, ±5s, quality — mirroring the headset in
real time.

**Local files:** paste an absolute path (`/Users/you/Movies/clip.mp4`, `~/…`,
or a `file://` URL) into the remote page. Compatible files stream directly
from disk; MKV/WebM/AV1 files are remuxed or transcoded on the fly.

## Limitations

- **DRM services (Netflix, Disney+, Prime…) cannot work** — their streams are
  encrypted end-to-end, and this tool makes no attempt to circumvent that.
- A browser-extension "VPN" only tunnels the browser; the server won't inherit
  it. System-wide VPN apps work.
- Some YouTube 360° videos use EAC projection and look warped (equirectangular
  support only, for now).
- If the server's Wi-Fi IP changes, delete `certs/`, re-run `./setup.sh`, and
  redo the trust steps (or use the `https://<hostname>.local:8443` address,
  which survives IP changes).
- Linux/Windows server and Android phone support is implemented but has had
  less real-world testing than macOS + iPhone — issues and PRs welcome.

## Legal note

This tool is for **personal viewing** of content you have the right to watch.
It streams (never stores) video through your own machine, honours DRM by
simply not supporting protected services, and uses your own browser session
for access. Respect the terms of service of the sites you use and the
copyright laws of your jurisdiction.

## License

[MIT](LICENSE)
