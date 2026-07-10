#!/bin/bash
# One-time setup: dependencies + self-signed certificate.
set -e
cd "$(dirname "$0")"

echo "== VR Video Streamer — setup =="

command -v node >/dev/null || { echo "ERROR: node not found. Install Node.js first (brew/apt/winget install node)."; exit 1; }
command -v yt-dlp >/dev/null || { echo "ERROR: yt-dlp not found. Install it first (brew install yt-dlp / pip install yt-dlp)."; exit 1; }
command -v ffmpeg >/dev/null || echo "WARNING: ffmpeg not found — transcoding, 4K merge, and previews will be disabled."

echo "-- Installing npm dependencies"
npm install --no-fund --no-audit

# LAN IP: macOS first, then Linux, then a generic fallback
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null \
  || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
IP=${IP:-127.0.0.1}
HOSTLOCAL="$(scutil --get LocalHostName 2>/dev/null || hostname -s 2>/dev/null || echo streamer).local"
SAN="DNS:$HOSTLOCAL,DNS:localhost,IP:$IP,IP:127.0.0.1"

mkdir -p certs
if [ -f certs/cert.pem ]; then
  echo "-- Certificate already exists (delete the certs/ folder and re-run to regenerate, e.g. after your Mac's IP changes)"
else
  echo "-- Generating self-signed certificate (IP: $IP, hostname: $HOSTLOCAL)"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 820 -nodes \
    -keyout certs/key.pem -out certs/cert.pem \
    -subj "/CN=VR Video Streamer/O=VRStreamer" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,digitalSignature,keyCertSign,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" \
    -addext "subjectAltName=$SAN" \
    2>/dev/null
fi

echo ""
echo "Setup complete. Next steps:"
echo ""
echo "  1. Trust the certificate on this computer (one-time; needed so the"
echo "     browser bookmarklet can reach the server):"
if [ "$(uname)" = "Darwin" ]; then
  echo "       sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certs/cert.pem"
else
  echo "       sudo cp certs/cert.pem /usr/local/share/ca-certificates/vr-streamer.crt && sudo update-ca-certificates"
  echo "     (or import certs/cert.pem in your browser's certificate settings)"
fi
echo ""
echo "  2. Start the server:"
echo "       npm start"
echo ""
echo "  3. On your phone (same Wi-Fi), open:  http://$IP:8080"
echo "     and follow the certificate steps shown there (one-time)."
