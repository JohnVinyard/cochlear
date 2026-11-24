#!/bin/sh
# issue-key.sh NAME ABOUT: creates the bot user NAME and an API key for it,
# the first time only (see issue-keys.sh). The key is kept in
# .data/bots/NAME.key; delete that file to issue a new one (e.g. after
# recreating the database).
set -e
name="$1"
about="$2"
dir="${BOT_KEY_DIR:-/app/.data/bots}"
key="$dir/$name.key"
if [ -s "$key" ]; then
    echo "$name already has a key ($key)"
    exit 0
fi
mkdir -p "$dir"
(cd /app/api && yarn -s cli create-bot "$name" --about "$about") > "$key.out"
# keep only the key itself, whatever else ends up on stdout
grep -E '^cka_' "$key.out" > "$key.tmp" || { echo "no key in the output of create-bot" >&2; exit 1; }
mv "$key.tmp" "$key.out"
chmod 600 "$key.out"
mv "$key.out" "$key"
# the container runs as root; give the files to whoever owns the repo
owner="$(stat -c %u:%g /app)"
chown "$owner" "$dir" "$key"
echo "issued a key for $name ($key)"
