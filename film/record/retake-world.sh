#!/bin/sh
# Re-take the World ID shot and swap it into the film.
#   1. needs `pnpm dev:all` running (World ID routes on the Noren server, the forks, the CRE bridge) and the saved
#      browser profile from the earlier takes (record/state/state.json: the same wallet as the rest of the film);
#   2. opens the real IDKit request in a visible Chrome window, re-opening it every ~4.6 min (requests expire after 5),
#      and writes the current World App link to record/state/world-link.txt for a phone that can't scan its own screen;
#   3. stops as soon as GET /world-id/status/<wallet> says verified (or after WORLD_WAIT_MIN, default 30);
#   4. when verified, 05c uses the verified shot and the matching voice line, and the film is re-rendered.
# No 0G call is made here: World ID verification never asks the underwriter.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
curl -sf http://127.0.0.1:8790/world-id/config >/dev/null || { echo "Setup required: start the stack first (pnpm dev:all from the repo root)"; exit 1; }
curl -sf http://localhost:5190/ >/dev/null || { echo "Setup required: start the web app (pnpm --filter @noren/web dev)"; exit 1; }
cd "$HERE"
[ -d node_modules/playwright ] || pnpm install --ignore-workspace
rm -f state/world-ready.txt state/world-link.txt
node record.mjs world &
REC=$!
# decode each fresh QR into its World App link (jsQR, from this folder's node_modules)
( last=""; while kill -0 $REC 2>/dev/null; do
    m=$(stat -f %m state/world-qr.png 2>/dev/null || stat -c %Y state/world-qr.png 2>/dev/null || true)
    if [ -n "$m" ] && [ "$m" != "$last" ]; then last=$m; sleep 1
      node -e 'import("jsqr").then(async ({default:q})=>{const {PNG}=await import("pngjs");const p=PNG.sync.read(require("fs").readFileSync("state/world-qr.png"));const r=q(new Uint8ClampedArray(p.data),p.width,p.height);console.log(r?r.data:"NO_QR")})' > state/world-link.txt
      echo "World App link: $(cat state/world-link.txt)"; fi
    sleep 2; done ) &
wait $REC
if grep -q '"world-verified"' takes/world.events.json; then
  echo "World ID verified: re-rendering with the verified shot"
  cd .. && NO_CUT= sh edit/render.sh
else
  echo "World ID not verified in time; the film keeps the pending shot. Run this again to retry."
fi
