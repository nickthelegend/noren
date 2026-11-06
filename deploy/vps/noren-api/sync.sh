#!/usr/bin/env bash
# Copies this checkout (no keys, no node_modules, no .env*) to /opt/hk/noren-api on the VPS and installs the compose file.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SSH="ssh -i $HOME/.ssh/hackathon_vps"
HOST=root@201.18.198.162
# dockerignore patterns are root-relative; anchor them for rsync ("/film", not every "film").
LIST="$(mktemp)"; trap 'rm -f "$LIST"' EXIT
sed -E 's#^([^*/][^*]*)$#/\1#' "$ROOT/deploy/vps/noren-api/dockerignore" > "$LIST"
rsync -az --delete -e "$SSH" --exclude-from="$LIST" --exclude=.env --exclude='.env.*' --exclude=/robinhood --exclude=/docker-compose.yml --exclude=/.dockerignore \
  "$ROOT/" "$HOST:/opt/hk/noren-api/"
scp -q -i "$HOME/.ssh/hackathon_vps" "$ROOT/deploy/vps/noren-api/docker-compose.yml" "$HOST:/opt/hk/noren-api/docker-compose.yml"
scp -q -i "$HOME/.ssh/hackathon_vps" "$ROOT/deploy/vps/noren-api/dockerignore" "$HOST:/opt/hk/noren-api/.dockerignore"
