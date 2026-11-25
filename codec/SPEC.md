# cochlea codec: format specification (draft 0.2)

> **Status:** first draft. Expect breaking changes until 1.0. The open
> questions are at the end.

The cochlea codec describes audio as a tree of **parameters for a pluggable
decoder**, not as samples. An encoded file is a JSON document. It can be
tracked in source control, read by people (to a degree), and transformed by
anything that can manipulate a tree: [JSONata](https://jsonata.org/), `jq`,
or a few lines of Python. The line between a codec and a DAW or tracker is
deliberately blurred.

The decoder starts with two modules. The **sampler** plays (part of) a sound
from a URI, with minimal processing. The **sequencer** schedules other nodes
in time. Everything else is an **extension**. The first one is
`org.cochlea.gammatone`, a trivial generator that exists to exercise the
extension path.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## Terms

| Term | Meaning |
|---|---|
| document | A JSON object in this format |
| node | A JSON object with a `type`. Each node describes a sound. |
| module | The implementation of one node `type`, e.g. the sampler |
| extension | A module that isn't part of the core (`sampler`, `sequencer`) |
| decoder | Turns a document into samples, using its registered modules |
| definition | A value in a document's `defs`, used anywhere with a `$ref` |
| host | The program running the decoder: a browser page, a CLI, a plugin. It does all I/O. |

## Documents

```json
{
  "$schema": "https://…/document.schema.json",
  "format": "cochlea-codec",
  "version": "0.2",
  "requires": { "org.cochlea.gammatone": "0.1" },
  "meta": { "title": "anything" },
  "defs": { "kick": { "type": "sampler", "url": "kick.wav" } },
  "root": { "type": "sequencer", "events": [{ "time_seconds": 0, "node": { "$ref": "#/defs/kick" } }] }
}
```

| Field | | |
|---|---|---|
| `format` | required | Always `"cochlea-codec"` |
| `version` | required | The format version, `"major.minor"`. A decoder MUST reject a major version it doesn't support, and SHOULD reject a newer minor version. |
| `requires` | optional | The modules the document needs, as `{type: minimum version}`. See [Extensions](#extensions). |
| `defs` | optional | Definitions: named values to use many times. See [References](#references). |
| `root` | required | The node to play |
| `meta` | optional | Any object. Decoders MUST ignore it. |
| `$schema` | optional | For editors. Decoders MUST ignore it. |

Any other field is an error. JSON Schemas for documents and for each module
are in [`schema/`](schema).

### Files and media type

| | |
|---|---|
| File extension | `.sprs` |
| Media type | `audio/vnd.cochlea.sprs+json` (not yet registered) |
| Encoding | UTF-8 JSON (RFC 8259) |

- **Why this media type.** A bare `audio/sprs` would sit in IANA's
  *standards tree*, which is for formats published by standards bodies. The
  *vendor tree* (`vnd.`) is the open, first-come route for a format like
  this one. The `+json` structured-syntax suffix (RFC 6839) tells generic
  tools (editors, browser dev tools, proxies, compressors) that the body is
  JSON, even if they've never heard of the format. It's under `audio/`
  because a document *is* audio, given a decoder (as `audio/midi` is).
- **Hosts** SHOULD also accept documents served as `application/json`, or
  named `.json`, as the examples in this repository are.
- **Compression** belongs to the transport, not the format: serve documents
  with HTTP `Content-Encoding: gzip` (or `br`). They compress well: the
  MusicNet example is 25× smaller gzipped (70 KB → 2.8 KB); `drums.json`,
  whose hi-hat is an embedded base64 sample, only 3× (11 KB → 3.9 KB).
- **In the annotation API,** a document that encodes a sound is one of that
  sound's formats (`POST /v1/sounds/{id}/formats`), with this media type, and
  metadata such as `{"version": "0.2", "requires": {...}}`.

## Nodes

Every node is an object with a string `type`, which selects the module that
decodes it. Every node MAY also have:

- `label`: a human-readable name, for viewers and editors;
- `meta`: any object, ignored by decoders. Use it for provenance, editor
  state, and so on.

Everything else is the module's parameters. Modules MUST reject parameters
they don't know. A typo such as `"gian": 0.5` is an error, not silence.
Anything a module should ignore belongs in `meta`.

A decoder MUST reject a node whose `type` it has no module for, and SHOULD
name the type and list the types it supports.

A version `"major.minor"` is compared as two numbers (`0.10` is newer than
`0.9`). Something written for `a.b` can be read by an implementation of
`a.c` when `b ≤ c`.

### Errors

Errors SHOULD carry a [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)
to where they occurred, e.g. `/root/events/3/node`. An error inside a
definition SHOULD point at the definition, which is where it can be fixed,
and say where it was used.

## References

Anything can be defined once, in `defs`, and used many times: a sound's
URI, an envelope, a single sound, or a whole pattern.

```json
"defs": {
  "kick-sound": "https://example.com/kick.wav",
  "kick": { "type": "sampler", "label": "kick", "url": { "$ref": "#/defs/kick-sound" } },
  "four-kicks": { "type": "sequencer", "events": [
    { "time_seconds": 0,   "node": { "$ref": "#/defs/kick" } },
    { "time_seconds": 0.5, "node": { "$ref": "#/defs/kick" } },
    { "time_seconds": 1,   "node": { "$ref": "#/defs/kick" } },
    { "time_seconds": 1.5, "node": { "$ref": "#/defs/kick" } }
  ] }
},
"root": { "type": "sequencer", "events": [
  { "time_seconds": 0, "node": { "$ref": "#/defs/four-kicks" } },
  { "time_seconds": 2, "node": { "$ref": "#/defs/four-kicks", "label": "bar 2" } }
] }
```

- A **reference** is an object `{"$ref": "#/defs/…"}`. It stands in for the
  value it points to, and can replace any value inside `root` or `defs`,
  except inside `meta` (which is opaque, so it may use `$ref` to mean
  something else).
- The `$ref` is a URI fragment holding a JSON Pointer, and it MUST point
  into `defs`, e.g. `#/defs/four-kicks` or `#/defs/drums/kick`. Pointers
  elsewhere (`#/root/…`), and to other documents, are errors for now.
- Definitions may refer to other definitions. A cycle is an error.
- A reference MAY also have `label` and `meta`, which replace the target's.
  This only works when the target is an object. Any other key next to a
  `$ref` is an error. There are no parameter overrides yet (see the open
  questions).
- A document means the same thing as the one you get by replacing every
  reference with a copy of its target. Decoders MAY implement references
  that way, and SHOULD limit how far a document can expand, since nested
  patterns grow exponentially.
- Definitions that nothing refers to are ignored.

**Paths.** Each *use* of a definition is a separate node. A node is
identified by its **instance path**, where it is in the expanded tree (e.g.
`/root/events/1/node/events/2/node`). Instance paths are unique, so
layouts, errors and solo playback use them. Decoders SHOULD also report
each node's **source**, the pointer to its JSON in the document (here
`/defs/kick`), so that viewers and editors can show and edit the
definition, and find everywhere it plays.

## Time

Times are in **seconds**.

A node's **timeline** starts when the node starts. A sequencer places each
child at a time on its own timeline, and its `speed` (default 1) scales that
timeline: an event at `time_seconds: t` in a sequencer at speed `s` starts
`t / s` seconds after the sequencer starts. Speed **compounds** through
nested sequencers: each sequencer's timeline is scaled by its own speed and
by every enclosing sequencer's.

For a node at depth *d*, reached through events with times *t₁…t_d* in
sequencers whose speeds are *s₁…s_d* (outermost first), the absolute start
time is:

    start = Σᵢ tᵢ / (s₁ · s₂ · … · sᵢ)

Speed changes **when** things play, not **how** they sound. Leaf nodes
(samplers, gammatones) are not pitched, stretched or shortened by it. A
node's duration is its own; a sequencer lasts until its last child ends.

Decoders convert times to frames by rounding *absolute* times, so that
rounding errors don't accumulate down the tree.

## Rendering

- Output is **mono**. Stereo, panning and spatialisation are open questions.
- The host chooses the output **sample rate**. Resources are resampled to it.
- Overlapping nodes are **summed**, with no limiting or normalisation.
  Keeping the peak below 1.0 is the author's job, and clipping is the
  host's concern.
- Decoding is **deterministic**: the same document, resources and sample
  rate give the same samples, up to floating-point differences between
  platforms.

## Resources

Nodes reference audio by URI. A decoder never does I/O itself. Instead:

1. **parse:** validate the document and build the node tree;
2. **resources:** the host asks for every URI the document needs, then
   fetches and decodes them itself;
3. **build/render:** the decoder renders, using the audio the host provided.

A decoder SHOULD also say which **spans** of each resource it needs (in
seconds; an open end is "to the end"), and accept audio for just those
spans, at an offset, with the resource's total length if the host knows it.
A sampler that plays half a second from an hour-long recording then needs
only that half second, which an HTTP host can fetch with a `Range` request.
Each module decides what it reads. The core sampler needs its slice
(`start_seconds` to `start_seconds + duration_seconds`), and its `convolve`
impulse response in full. A host MAY always provide all of a resource
instead. Spans change what's fetched, never what's heard.

Hosts MUST support:

- `data:` URIs (RFC 2397), base64 or percent-encoded;
- `http:` and `https:` URLs;
- relative references, resolved against the document's own URL or location.

Decoders MUST support WAV (8/16/24/32-bit integer PCM, 32/64-bit float, and
`WAVE_FORMAT_EXTENSIBLE`). They MAY support other formats; a browser host
supports whatever `decodeAudioData` does. Multi-channel audio is mixed down
to mono.

## Core modules

### `sampler` 0.1

Plays (part of) a sound.

```json
{
  "type": "sampler",
  "url": "https://example.com/snare.wav",
  "start_seconds": 0.0,
  "duration_seconds": 0.5,
  "gain": 0.8,
  "envelope": {
    "type": "exponential",
    "points": [{ "time_seconds": 0, "gain": 1 }, { "time_seconds": 0.5, "gain": 0.001 }]
  },
  "filter": { "type": "bandpass", "center_frequency": 2000, "bandwidth": 1000 },
  "convolve": { "url": "https://example.com/room.wav", "mix": 0.3 }
}
```

| Parameter | Default | |
|---|---|---|
| `url` | required | The sound |
| `start_seconds` | 0 | Where in the sound to start. It's an error to start past its end. |
| `duration_seconds` | to the end | How much to play. It's clamped to the end of the sound. |
| `gain` | 1 | Linear |
| `envelope.points` | none | `[{time_seconds, gain}]`, in time order. Times are relative to the start of the slice. The gain holds before the first point and after the last. |
| `envelope.type` | `linear` | `linear` or `exponential`. Exponential ramps interpolate in the log domain, with gains floored at 1e-4 (-80 dB). |
| `filter` | none | `bandpass` (the only type so far): an RBJ biquad with 0 dB peak gain and Q = `center_frequency / bandwidth`, both in Hz. The center must be below Nyquist. |
| `convolve.url` | none | An impulse response, e.g. a room. It's normalised to unit energy. |
| `convolve.mix` | required with `convolve` | 0 (all dry) to 1 (all wet) |

Processing order: **slice → envelope → filter → gain → convolve**. A
sampler's duration is its slice's, plus the impulse response's tail
(`ir_length - 1` frames) when it convolves.

### `sequencer` 0.1

Plays child nodes at given times.

```json
{
  "type": "sequencer",
  "speed": 2,
  "events": [
    { "time_seconds": 0, "node": { "type": "sampler", "url": "kick.wav" } },
    { "time_seconds": 0.5, "node": { "type": "sampler", "url": "snare.wav" } }
  ]
}
```

| Parameter | Default | |
|---|---|---|
| `speed` | 1 | > 0. Scales this timeline and every nested one (see [Time](#time)). |
| `events` | `[]` | `[{time_seconds, node}]`. `time_seconds` (≥ 0) is on this sequencer's timeline. Events needn't be in order, and may overlap. |

## Extensions

An extension is a module with a `type` name, a version, a JSON Schema for
its parameters, and an implementation. It follows the same rules as the core
modules: it rejects unknown parameters, does no I/O (it lists the URIs it
needs instead), and is deterministic.

**Names.** Core types (`sampler`, `sequencer`) have bare names, and bare
names are reserved for the core. An extension's `type` MUST be a
reverse-DNS name, based on a domain its author controls: at least three
dot-separated labels, each lowercase letters, digits and `-`, starting with
a letter, e.g. `org.example.theremin`. (This is the convention CLAP uses for
plugin and extension IDs.) A name, once published, means one thing. A
change that breaks documents gets a new major version, not a new name.

**Requirements.** A document SHOULD list the extensions it uses in
`requires`, with the minimum version of each:
`"requires": {"org.cochlea.gammatone": "0.1"}`. Core modules MAY be listed
too. A decoder MUST reject a document that requires a module it lacks, or
an incompatible version of one (see [Nodes](#nodes) for how versions
compare), before parsing anything else. That way a decoder fails up front,
and names what's missing.

In the Rust decoder (`rust/crates/codec`), an extension implements
`cochlea_codec::Module`:

```rust
impl Module for Gammatone {
    fn type_name(&self) -> &'static str { "org.cochlea.gammatone" }
    fn version(&self) -> &'static str { "0.1" }
    // validate the JSON and return a parsed Node (children go through cx.parse)
    fn parse(&self, node: &NodeRef, cx: &ParseContext) -> Result<Box<dyn Node>> { … }
}
impl Node for GammatoneNode {
    // fn resources(&self) -> Vec<String>      URIs needed, if any
    // fn resource_spans(&self) -> Vec<(String, Span)>   which parts of them (default: all)
    // fn children(&self) -> Vec<&Child>       for container nodes
    fn build(&self, cx: &BuildContext) -> Result<Box<dyn Voice>> { … }  // renders
}
```

It's registered with `decoder.register(Gammatone)`. `register` refuses a
name that isn't reverse-DNS. See
[`rust/crates/gammatone`](rust/crates/gammatone), which is meant as a
template.

### `org.cochlea.gammatone` 0.1 (extension)

The impulse response of a gammatone filter,
`t^(n-1) · e^(-2πbt) · cos(2πft + φ)`, scaled so its peak is `gain`.

| Parameter | Default | |
|---|---|---|
| `center_frequency` | required | f, in Hz, below Nyquist |
| `bandwidth` | `1.019 · ERB(f)` | b, in Hz, where `ERB(f) = 24.7 + 0.108·f` (Glasberg & Moore). Wider decays faster. |
| `order` | 4 | n, 1–10 |
| `phase` | 0 | φ, in radians |
| `gain` | 1 | Peak amplitude |
| `duration_seconds` | until -60 dB | At most 10 |

## Implementations

| | |
|---|---|
| [`rust/crates/codec`](rust/crates/codec) | The decoder: parsing, references, the module registry, sampler, sequencer, WAV and `data:` decoding, DSP |
| [`rust/crates/gammatone`](rust/crates/gammatone) | The example extension |
| [`rust/crates/wasm`](rust/crates/wasm) | WebAssembly build. It has a C ABI and no imports, so it can be instantiated synchronously in an `AudioWorkletProcessor`. |
| [`rust/crates/cli`](rust/crates/cli) | `cochlea-codec render doc.json out.wav` |
| `web/src/codec/` | The browser host: fetching and decoding, and an AudioWorklet that decodes on the audio thread |
| `web/src/elements/codec-viewer.ts` | `<codec-viewer>`: explore and play documents |

## Open questions

1. **Reuse, continued.** References (0.2) define a thing once and use it
   as-is. Open:
   - *Parameter overrides*: `{"$ref": "#/defs/kick", "gain": 0.5}`, like
     Csound's instruments, which are defined once and played with
     per-note parameters. It's powerful, but makes a reference mean
     something its target alone doesn't, and needs rules for nested
     values.
   - *Inherited defaults*, like SFZ, where an opcode on a `<group>`
     applies to every `<region>` inside it unless the region overrides it.
     It fits a tree well, but a node's JSON no longer tells you what it
     does.
   - *References to other documents* (`"$ref": "drums.json#/defs/bar"`):
     shared libraries of sounds and patterns, at the cost of documents
     that aren't self-contained, and of I/O at parse time.
2. **Extensions as code.** Today every decoder has to implement every
   extension it supports, natively. That's SFZ's situation, where
   players each support a different set of opcodes (made worse by SFZ
   players silently ignoring opcodes they don't know). Csound and MPEG-4
   Structured Audio put the instruments in the file, as programs, at the
   cost of heavy decoders. A middle way: an extension as a WebAssembly
   module, referenced from `requires` by URL and content hash, and run
   sandboxed through the same import-free C ABI as the decoder itself
   (compare Web Audio Modules, and the efforts to run CLAP plugins as
   WebAssembly). Documents stay data, and extensions travel without
   every decoder shipping them.
3. **Speed and pitch.** Should speed optionally resample (like tape) rather
   than only rescheduling? Should the sampler have a `rate` or a `pitch`?
   If so, borrow SFZ's vocabulary (`transpose`, `tune` in cents,
   `pitch_keycenter`) rather than inventing one.
4. **Channels.** Mono only for now. Options: a `pan` on every node, or
   multi-channel resources and output.
5. **Effects on containers.** Gain, envelopes and filters apply only to
   samplers. A sequencer-level (or generic "effect" node) chain would
   allow, say, a reverb on a whole bar. Is that a new node type that wraps
   one child?
6. **Streaming.** Leaf modules precompute their whole output when they're
   built, and the browser builds the document inside the AudioWorklet,
   which briefly blocks the audio thread. Long sources or long impulse
   responses would need incremental rendering, and building in a Worker.
   References make a related optimisation possible: a definition's output
   could be rendered once and shared by every use.
7. **Loudness.** Impulse responses are normalised to unit energy. Web
   Audio's `ConvolverNode` uses a different calibration, so the reference
   implementation in `web-components/components/synth.ts` will sound louder
   or quieter.
8. **Encoders.** Out of scope for now. The motivating example is matching
   pursuit: decompose a sound into atoms, host the atom dictionary, and
   describe the sound as timed sampler events. This is probably what
   decides whether the format is useful (see below).

9. **Naming.** Files are `.sprs` and `audio/vnd.cochlea.sprs+json`, but a
   document's `format` field still says `"cochlea-codec"`. Should it say
   `"sprs"`? Changing it is a breaking change (a new major version, or
   decoders accepting both for a while). And `vnd.cochlea` assumes the project
   keeps its name; the media type should be registered with IANA once the
   names settle.

## Prior art

| | What it is | What we take from it |
|---|---|---|
| MIDI, MusicXML | Events, without sound | Nothing directly; a source to import from |
| SFZ, SoundFont | Sample-based instruments: regions with offsets, envelopes, filters, under inherited `<group>` defaults | The sampler's scope, vocabulary for pitch and envelopes, and a warning: silently ignored opcodes fragmented the players, which is why unknown parameters are errors here |
| Tracker modules (MOD, XM, IT) | Samples plus patterns, in one file; patterns refer to samples by index | Define once, refer many times |
| VST3, CLAP, LV2 | Binary plugin ABIs; presets are opaque blobs | CLAP's reverse-DNS IDs for plugins and extensions. The decoder could itself become a CLAP instrument; hosting native plugins *inside* documents would end portability and determinism. |
| Web Audio Modules | A plugin standard for the browser | Prior art for extensions as WebAssembly (open question 2) |
| Csound | An orchestra of instruments (programs) and a score of timed events with positional parameters | The same shape as modules plus sequencers. We use named, typed parameters rather than positional ones, so documents can be read and transformed without the instruments. |
| MPEG-4 Structured Audio (SAOL/SASL) | An ISO codec (1999) whose bitstream is Csound-like instruments and a score | The closest precedent for the whole idea. It saw little use: decoders needed a full language, results varied between them, and there was no practical encoder from recordings. |
| SuperCollider, Faust | Synthesis languages (Faust compiles to WebAssembly) | Programs, not data; Faust is a candidate for writing extensions |

The aim here is sparse, human-readable data that *is* the sound, given a
decoder.
