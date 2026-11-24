#!/bin/sh
# Run by the bot-keys compose service: makes sure every bot has a user and an
# API key (in .data/bots/<name>.key). Add new bots here.
set -e
cd "$(dirname "$0")"
sh issue-key.sh featurebot "Annotates every sound with its onsets, and frame-level chroma and MFCCs (librosa)"
sh issue-key.sh segmentbot "Gives every onset segment a vector (chroma and MFCC) for similarity search"
