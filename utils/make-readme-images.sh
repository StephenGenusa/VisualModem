#!/usr/bin/env bash
# Rebuilds the README images in images/ from the app's own code:
#   send-frame.png     one Send frame (block 28, 4K screen, drawn at 7 px a block)
#   probe.gif          half a Probe loop at real speed, with captions
#   send-page.gif      the Send page scrolling top to bottom, measuring a 4K display
#   phone-receive.png  the Receive page held sideways during a transfer
# Needs node, ImageMagick (convert), Firefox and python3. Work files go to scratch/readme.
# Firefox may be a snap, so its profile and output stay under the project (not /tmp).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$ROOT/scratch/readme
PORT=${PORT:-8097}
HOSTNAME_=visual-modem.local
rm -rf "$WORK" && mkdir -p "$WORK/cap" "$WORK/site" "$WORK/prof" "$WORK/scroll"
cd "$ROOT"

# 1. Frames from the app's code.
CW=640 CH=360 node utils/readme-frames.mjs "$WORK"
cp "$WORK/send-frame.png" images/send-frame.png

# 2. Probe GIF: a caption bar under each frame, then the encoder.
node -e '
const fs = require("fs"); const dir = process.argv[1];
const f = JSON.parse(fs.readFileSync(dir + "/probe/frames.json"));
const caps = [...new Set(f.map((x) => x.caption))];
fs.writeFileSync(dir + "/caps.txt", caps.join("\n") + "\n");
fs.writeFileSync(dir + "/map.txt", f.map((x) => x.name + "\t" + caps.indexOf(x.caption)).join("\n") + "\n");
fs.writeFileSync(dir + "/cap/frames.json", JSON.stringify(f));' "$WORK"
i=0
while IFS= read -r c; do
  convert -size 640x34 xc:'#111111' -fill '#e8e8e8' -font DejaVu-Sans -pointsize 15 -gravity center -annotate +0+0 "$c" "$WORK/cap/c$i.png"
  i=$((i + 1))
done < "$WORK/caps.txt"
while IFS=$'\t' read -r name ci; do
  convert "$WORK/probe/$name" "$WORK/cap/c$ci.png" -append "$WORK/cap/$name"
done < "$WORK/map.txt"
node --max-old-space-size=4096 utils/gif-encode.mjs "$WORK/cap" "$WORK/cap/frames.json" images/probe.gif

# 3. A copy of the page that measures a 3840 x 2160 display, served on loopback.
cp -r web "$WORK/site/web"
ln -s "$ROOT/src" "$WORK/site/src"
node -e '
const fs = require("fs"); const p = process.argv[1] + "/site/web/index.html";
const inj = "<script>Object.defineProperty(window,\"devicePixelRatio\",{get:()=>3});Object.defineProperty(window,\"screen\",{get:()=>({width:1280,height:720,availWidth:1280,availHeight:720})});</script>\n";
fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("<head>", "<head>\n" + inj));' "$WORK"
cat > "$WORK/site/set.html" <<'EOF'
<!doctype html><meta charset="utf-8"><script>
try { localStorage.setItem('visual-modem:screen', JSON.stringify({ blockSize: 28, levels: 2, scheme: 'cube', parity: 32, fps: 10, white: 255, fountain: true })); } catch (e) {}
</script>
EOF
cat > "$WORK/site/wrap.html" <<'EOF'
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;overflow:hidden;background:#000}iframe{border:0;position:absolute;left:0;width:1280px;height:3400px}</style>
<body><iframe id="f" src="/web/#send"></iframe>
<script>document.getElementById('f').style.top = '-' + (new URLSearchParams(location.search).get('y') || 0) + 'px';</script>
EOF
cp "$WORK/camera.png" "$WORK/site/web/camera.png"
node -e '
const fs = require("fs"); const dir = process.argv[1];
const q = JSON.parse(fs.readFileSync(dir + "/camera-quad.json"));
const pts = q.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");
fs.writeFileSync(dir + "/site/web/phone.html", `<!doctype html>
<html lang="en" data-theme="sage"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="app.css">
<style>.camera-box img{display:block;width:100%;height:100%}.camera-box svg{position:absolute;left:0;top:0;width:100%;height:100%}</style></head>
<body class="rx-active"><nav class="tabs"><a href="#send">Send</a><a href="#receive" aria-current="page">Receive</a></nav>
<main><section id="receive" class="tab"><div class="rx-run">
<div class="camera-box" style="--cam-ar: 1.7778"><img src="camera.png" alt="">
<svg viewBox="0 0 1920 1080" preserveAspectRatio="none"><polygon points="${pts}" fill="none" stroke="#00e060" stroke-width="6"/></svg></div>
<div class="rx-panel">
<p class="rx-state st st-work">Receiving</p>
<progress max="958" value="612"></progress>
<p class="rx-count">612 / 958 pieces<span>0:05 elapsed · 0:03 left</span></p>
<div class="rx-signal"><p>Reads 27 of last 30 (90%)</p><p>Main miss: Frames found but too many errors: tearing, blur or glare</p><p class="rx-hint">Aim is good, the TV fills 86% of the width</p></div>
<p class="rx-details"><span>Grid 137×77, rgb 2/2/2 · </span><span>Camera 1920x1080</span> · <span>12 fps read</span> · <span>CRC pass 61, fail 3</span><span> · Margin 74%</span></p>
</div></div></section></main></body></html>`);' "$WORK"

cat > "$WORK/prof/user.js" <<EOF
user_pref("network.dns.forceResolve", "127.0.0.1");
user_pref("dom.securecontext.allowlist", "$HOSTNAME_");
user_pref("browser.shell.checkDefaultBrowser", false);
EOF
(cd "$WORK/site" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1
shot() { timeout 90 firefox --headless --no-remote --profile "$WORK/prof" --window-size="$1" --screenshot "$2" "$3" >/dev/null 2>&1 || true; }
H="http://$HOSTNAME_:$PORT"
shot 1280,720 "$WORK/set.png" "$H/set.html"

# 4. The Send page in 720 px slices, stitched, then cut into a smooth scroll.
parts=()
for y in 0 720 1440 2160 2880; do shot 1280,720 "$WORK/part-$y.png" "$H/wrap.html?y=$y"; parts+=("$WORK/part-$y.png"); done
convert "${parts[@]}" -append "$WORK/tall.png"
height=$(convert "$WORK/tall.png" -trim -format '%h' info:)
convert "$WORK/tall.png" -crop "1280x$((height + 8))+0+0" +repage -resize 960x "$WORK/tall960.png"
node utils/scroll-frames.mjs "$WORK/tall960.png" "$WORK/scroll" 540 12 20
node --max-old-space-size=4096 utils/gif-encode.mjs "$WORK/scroll" "$WORK/scroll/frames.json" images/send-page.gif

# 5. The Receive page at a sideways phone's viewport, in a phone-shaped frame.
shot 844,322 "$WORK/phone.png" "$H/web/phone.html"
convert "$WORK/phone.png" \( +clone -alpha extract -draw "fill black polygon 0,0 0,18 18,0 fill white circle 18,18 18,0" \( +clone -flip \) -compose Multiply -composite \( +clone -flop \) -compose Multiply -composite \) -alpha off -compose CopyOpacity -composite "$WORK/screen-rounded.png"
convert -size 924x402 xc:none -fill '#1b1b1d' -draw "roundrectangle 0,0 923,401 54,54" -fill '#3a3a3e' -draw "roundrectangle 3,3 920,398 51,51" \
  -fill '#0d0d0f' -draw "roundrectangle 8,8 915,393 47,47" "$WORK/screen-rounded.png" -geometry +40+40 -composite \
  \( +clone -background black -shadow 50x10+0+6 \) +swap -background none -layers merge +repage -depth 8 -strip images/phone-receive.png
ls -la images
