# Builds the codec's WebAssembly decoder (see codec/build-wasm.sh)
FROM rust:1-slim-bookworm
RUN rustup target add wasm32-unknown-unknown
WORKDIR /app
