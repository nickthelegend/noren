#!/bin/sh
# Rebuilds the edit from edit/edl.py, checks it, renders renders/noren-demo-v6.mp4 (gitignored) and a <=20 MB web copy.
#   sh edit/render.sh            (from film/)    NO_CUT=1 keeps the existing footage cuts
set -eu
cd "$(dirname "$0")/.."
python3 edit/build.py ${NO_CUT:+--no-cut}
npx --yes hyperframes@0.9.19 check
mkdir -p renders
npx --yes hyperframes@0.9.19 render -o renders/noren-demo-v6.mp4 -q delivery --video-frame-format png --workers 2 --skill hyperframes
# web copy: two-pass H.264 at a bitrate that lands under 20 MB for 180 s (~800 kb/s video + 96 kb/s audio)
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 renders/noren-demo-v6.mp4)
VB=$(python3 -c "print(int((19.0*8*1024*1024/$D - 96000)/1000))")
ffmpeg -v error -y -i renders/noren-demo-v6.mp4 -c:v libx264 -preset slow -b:v ${VB}k -pass 1 -an -f mp4 -passlogfile renders/.pass /dev/null
ffmpeg -v error -y -i renders/noren-demo-v6.mp4 -c:v libx264 -preset slow -b:v ${VB}k -pass 2 -passlogfile renders/.pass -c:a aac -b:a 96k -movflags +faststart renders/noren-demo-v6-web.mp4
rm -f renders/.pass*
for f in renders/noren-demo-v6.mp4 renders/noren-demo-v6-web.mp4; do
  printf '%s  %s s  %s MB\n' "$f" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")" "$(du -m "$f" | cut -f1)"
done
