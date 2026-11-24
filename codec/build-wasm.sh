#!/bin/sh
# Builds the WebAssembly decoder into web/public/codec/, where the web app
# loads it from. Run from anywhere; used by `yarn build-codec` and by the
# `codec` docker compose service.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET_DIR=${CARGO_TARGET_DIR:-$ROOT/codec/rust/target}
OUT=$ROOT/web/public/codec

cargo build --manifest-path "$ROOT/codec/rust/Cargo.toml" -p cochlea-codec-wasm \
    --target wasm32-unknown-unknown --release
mkdir -p "$OUT"
cp "$TARGET_DIR/wasm32-unknown-unknown/release/cochlea_codec_wasm.wasm" "$OUT/cochlea_codec.wasm"
# in docker this runs as root; hand the output to whoever owns the repo
if [ "$(id -u)" = 0 ]; then
    chown -R "$(stat -c %u:%g "$ROOT")" "$OUT"
fi
echo "built $OUT/cochlea_codec.wasm ($(wc -c < "$OUT/cochlea_codec.wasm") bytes)"
