#!/bin/sh
# Builds assets/Filedrawer.icns from design/app-icon.svg. Run from the repo root.
# Chrome draws the SVG at 1024 pixels, sips makes the smaller sizes and
# iconutil packs them.
set -e
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d)
SET="$TMP/Filedrawer.iconset"
mkdir -p "$SET"
printf '<html><body style="margin:0;background:transparent"><img src="%s" width="1024" height="1024"></body></html>' "file://$PWD/design/app-icon.svg" > "$TMP/icon.html"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 \
  --allow-file-access-from-files --window-size=1024,1024 --screenshot="$TMP/1024.png" "file://$TMP/icon.html" >/dev/null 2>&1
for n in 16 32 128 256 512; do
  sips -z $n $n "$TMP/1024.png" --out "$SET/icon_${n}x${n}.png" >/dev/null
  d=$((n * 2))
  sips -z $d $d "$TMP/1024.png" --out "$SET/icon_${n}x${n}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o assets/Filedrawer.icns
rm -rf "$TMP"
echo "assets/Filedrawer.icns"
