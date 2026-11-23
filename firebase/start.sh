#!/bin/sh
# Persist emulator accounts across restarts, so that firebase uids keep
# matching the users table in the (also persistent) local database.
#
# /data is a bind mount;  the emulator exports by renaming a temp dir onto
# the target, which fails on a mount point ("Device or resource busy"), so
# export into a subdirectory of it instead.
set -e
EXPORT_DIR=/data/export
IMPORT=""
if [ -f "$EXPORT_DIR/firebase-export-metadata.json" ]; then
    IMPORT="--import $EXPORT_DIR"
fi
exec firebase emulators:start --only auth --project demo-cochlea $IMPORT --export-on-exit "$EXPORT_DIR"
