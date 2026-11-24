# codec

An experimental audio codec whose encoded form is a JSON tree of parameters
for a pluggable decoder: a sampler, a sequencer and extensions. It's
standalone technology, kept in this repo as a companion to the annotation
API. The format is specified in [`SPEC.md`](SPEC.md).

| | |
|---|---|
| [`SPEC.md`](SPEC.md) | The format, draft 0.2, with open questions and prior art |
| [`schema/`](schema) | JSON Schemas for documents and for each module |
| [`examples/`](examples) | Example documents, made by `examples/generate.py` |
| [`rust/`](rust) | The decoder (Rust): core, the `org.cochlea.gammatone` extension, a WebAssembly build and a CLI |
| `../web/src/codec/`, `../web/src/elements/codec-viewer.ts` | The browser host and the `<codec-viewer>` element |

The decoder is written in Rust and compiled to WebAssembly, rather than built
on Web Audio nodes. That way one implementation runs in an
`AudioWorkletProcessor` in the browser and natively in CLIs, desktop apps
and, maybe later, plugins.

## Trying it

With `yarn dev` running, open http://localhost:5173/labs/codec. It's a hidden
page: it isn't in the nav and doesn't need a sign-in. The `codec` compose
service builds the WebAssembly decoder into `web/public/codec/` when the
stack starts.

From the command line (needs a Rust toolchain):

```bash
cargo run --manifest-path codec/rust/Cargo.toml --release -p cochlea-codec-cli -- \
    render codec/examples/drums.json drums.wav
# just the double-time fill at the end of phrase 2, timed as it is in the whole song:
cargo run ... -- render codec/examples/drums.json fill.wav --node /root/events/1/node/events/3/node
cargo run ... -- describe codec/examples/gammatones.json     # where every node plays
```

## Building and testing

```bash
yarn build-codec       # WebAssembly decoder -> web/public/codec/ (or: docker compose run --rm codec)
yarn test-codec        # cargo test, plus the examples against the JSON schemas
python3 codec/examples/generate.py --musicnet-dir ~/workspace/audio-data/musicnet   # regenerate examples
```

The browser loads the decoder from `/codec/cochlea_codec.wasm`. After
changing Rust code, rebuild it and reload the page.
