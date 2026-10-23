#!/bin/sh
# Render icon/icon.svg into icon/scratch.icns (app bundle) and public/icon.png
# (window and favicon). Needs ImageMagick; iconutil ships with macOS.
set -e
cd "$(dirname "$0")/.."
magick -background none -density 144 icon/icon.svg -resize 1024x1024 icon/icon-1024.png
set_dir=icon/scratch.iconset
rm -rf "$set_dir" && mkdir "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s icon/icon-1024.png --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d icon/icon-1024.png --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o icon/scratch.icns
rm -rf "$set_dir"
sips -z 256 256 icon/icon-1024.png --out public/icon.png >/dev/null
