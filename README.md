# VR Video Streamer 🎥📱

Watch any web video in a Google Cardboard headset — with one click.

You browse to a video on your Mac, click a bookmarklet, and seconds later it's
playing on your iPhone in side-by-side VR with gyroscope head tracking. No app
to install, no downloading videos, no copying links to your phone.

```
Chrome (Mac) ──bookmarklet──▶ local server (Mac) ──yt-dlp + proxy──▶ video site
                                     │                                  ▲
                                     ▼ Wi-Fi (HTTPS + WebSocket)        │ VPN (if any)
                              iPhone Safari (VR player)                 │ lives here
```

## Why this exists

Watching VR (360°/180°/3D) web videos in a phone-based headset normally means
downloading the file, transferring it to the phone, and opening it in a player
app. This tool collapses all of that into one click — and adds a property that
downloaders can't offer: **the phone never contacts the video site**. The Mac
resolves and fetches everything, so a video that needs the Mac's VPN, login
session, or region streams to the phone with none of that configured on it.

## Features

- **One-click send** from any page via a bookmarklet, or paste a URL — or a
  **local file path** — into the remote page
- **Works on ~1,800 sites** (everything [yt-dlp](https://github.com/yt-dlp/yt-dlp)
  supports), plus direct video links, plus an HTML-sniffing fallback for
  unknown sites
- **VPN / session passthrough**: extraction uses your Chrome cookies and all
  bytes flow through the Mac, so the phone needs no VPN, account, or region
- **Cardboard VR player in Safari** — no app store: Three.js stereo rendering
  with **barrel lens correction** (the round per-eye viewports real Cardboard
  apps use), optics-matched field of view for a true-to-scale feel, real
  inter-eye separation for 3D depth, gyroscope head tracking, 360° / 180° /
  flat projections, mono / side-by-side / top-bottom layouts, fullscreen,
  recenter
- **Two viewing modes**: **VR** (headset: dual distorted eyes) and **360**
  (handheld magic window: one fullscreen view, look around by moving the
  phone). Settings are remembered between sessions
- **Automatic compatibility transcoding**: AV1/VP9 video (which iPhones can't
  decode) is hardware-transcoded to HEVC on the Mac and delivered as HLS;
  wrong-container files (MKV, WebM) are losslessly remuxed
- **Dynamic quality menu** showing the renditions each video actually offers,
  up to 4K (`MAX_HEIGHT=1440 npm start` to cap lower on slow connections)
- **Smooth playback**: read-ahead chunk caching and HLS segment prefetching on
  the Mac, so seeks and playback don't wait on CDN round-trips
- **Two-way remote control**: play/pause/seek/quality from the phone HUD *or*
  live from the Mac's remote page, kept in sync over WebSocket
- **Self-healing streams**: expired/throttled CDN links are re-extracted
  automatically

## Requirements

- macOS (Apple Silicon recommended for hardware transcoding), Node.js ≥ 18
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org)
- iPhone with iOS 16.4+ (older works too, minus in-browser fullscreen — use
  "Add to Home Screen" instead)
- Both devices on the same Wi-Fi network

## Setup (one time, ~5 minutes)

### Mac

```bash
brew install node yt-dlp ffmpeg
git clone https://github.com/GhanibhutiGogoi/vr-video-streamer.git
cd vr-video-streamer
./setup.sh          # installs deps + generates a self-signed certificate
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain certs/cert.pem
npm start
```

The server prints its addresses. Open `https://<mac-ip>:8443/remote` in Chrome
and drag the **▶ Send to VR** button to your bookmarks bar.

> **Why a certificate?** iOS only exposes the gyroscope to HTTPS pages, so the
> local server must speak TLS, and both devices must trust its self-signed
> cert. It never leaves your machines.

### iPhone (same Wi-Fi)

1. Open `http://<mac-ip>:8080` in Safari → download the certificate.
2. Settings → **Profile Downloaded** → Install.
3. Settings → General → About → **Certificate Trust Settings** → enable full
   trust for "VR Video Streamer".
4. Open `https://<mac-ip>:8443` — that's the player. Tap **Enter VR**, allow
   motion access, slide the phone into the headset.

## Daily use

1. `npm start` on the Mac (or double-click `Start VR Streamer.command`).
2. Open the player on the phone, tap **Enter VR**, mount it in the headset.
3. Browse to any video on the Mac → click **▶ Send to VR**.

**In-headset:** single tap = menu · double tap = play/pause. The menu has
view mode (VR headset / 360 handheld), projection (360°/180°/flat), 3D layout,
quality, ±5s skip, recenter, and fullscreen. The phone can't auto-detect
whether a video is 360° or flat, so pick the matching projection once — all
settings are remembered.

**From the Mac:** the `/remote` page doubles as a live remote — title, seek
bar, play/pause, ±5s, quality — mirroring the headset in real time.

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
- 4K needs the *internet* side (video site → Mac) to sustain roughly the
  source bitrate (~15–25 Mbps). If it rebuffers, drop to 2K in the quality
  menu or start the server with `MAX_HEIGHT=1440`.
- If your Mac's Wi-Fi IP changes, delete `certs/`, re-run `./setup.sh`, and
  redo the trust steps (or use the `https://<hostname>.local:8443` address,
  which survives IP changes).

## Legal note

This tool is for **personal viewing** of content you have the right to watch.
It streams (never stores) video through your own machine, honours DRM by
simply not supporting protected services, and uses your own browser session
for access. Respect the terms of service of the sites you use and the
copyright laws of your jurisdiction.

## License

[MIT](LICENSE)
