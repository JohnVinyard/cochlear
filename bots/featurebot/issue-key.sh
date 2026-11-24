#!/bin/sh
# Run by the featurebot-key compose service: creates the featurebot user and
# an API key for it, the first time only. The key is kept in
# .data/bots/featurebot.key; delete that file to issue a new one (e.g. after
# recreating the database).
set -e
dir="${FEATUREBOT_KEY_DIR:-/app/.data/bots}"
key="$dir/featurebot.key"
if [ -s "$key" ]; then
    echo "featurebot already has a key ($key)"
    exit 0
fi
mkdir -p "$dir"
cd /app/api
yarn -s cli create-bot featurebot \
    --about "Annotates every sound with its onsets, and frame-level chroma and MFCCs (librosa)" > "$key.out"
# keep only the key itself, whatever else ends up on stdout
grep -E '^cka_' "$key.out" > "$key.tmp" || { echo "no key in the output of create-bot" >&2; exit 1; }
mv "$key.tmp" "$key.out"
chmod 600 "$key.out"
mv "$key.out" "$key"
# the container runs as root; give the files to whoever owns the repo
owner="$(stat -c %u:%g /app)"
chown "$owner" "$dir" "$key"
echo "issued a key for featurebot ($key)"
