//! Decoder for the cochlea codec: audio described as a (JSON) tree of
//! parameters for a pluggable decoder. See `codec/SPEC.md`.
//!
//! ```
//! use cochlea_codec::{Audio, Decoder};
//!
//! let mut decoder = Decoder::new(8000.0);
//! let doc = decoder.parse(r#"{
//!     "format": "cochlea-codec", "version": "0.2",
//!     "root": { "type": "sequencer", "events": [
//!         { "time_seconds": 0.5, "node": { "type": "sampler", "url": "click.wav" } }
//!     ] }
//! }"#).unwrap();
//! assert_eq!(doc.resources(), vec!["click.wav"]);
//! decoder.provide("click.wav", Audio::new(8000.0, vec![1.0; 10]));
//! let audio = decoder.render(&doc).unwrap().render_all();
//! assert_eq!(audio.samples.len(), 4010);
//! ```

pub mod audio;
pub mod dsp;
mod error;
pub mod modules;
pub mod node;
mod refs;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

pub use audio::Audio;
pub use error::{Error, Result};
pub use node::{BufferVoice, BuildContext, Child, Module, Node, NodeLayout, NodeRef, ParseContext, Voice};

pub const FORMAT: &str = "cochlea-codec";
/// The document format version this decoder reads (and any earlier minor version)
pub const VERSION: &str = "0.2";

/// Type names without a namespace, reserved for the core modules
pub const CORE_TYPES: [&str; 2] = ["sampler", "sequencer"];

/// `"major.minor"`, as numbers
fn parse_version(v: &str) -> Option<(u32, u32)> {
    let (major, minor) = v.split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// Whether something written for version `wanted` can be read by an implementation of `have`
fn compatible(wanted: &str, have: &str) -> bool {
    matches!((parse_version(wanted), parse_version(have)), (Some(w), Some(h)) if w.0 == h.0 && w.1 <= h.1)
}

/// Extension type names are reverse-DNS: at least three dot-separated
/// lowercase labels, e.g. `org.example.theremin`
pub fn is_extension_type(name: &str) -> bool {
    let labels: Vec<_> = name.split('.').collect();
    labels.len() >= 3
        && labels.iter().all(|l| {
            l.starts_with(|c: char| c.is_ascii_lowercase())
                && l.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
}

/// A parsed, validated document
pub struct Document {
    pub version: String,
    pub root: Child,
}

impl Document {
    /// Every URI the document needs, in document order, without duplicates
    pub fn resources(&self) -> Vec<String> {
        self.root.resources()
    }
}

/// Information about a registered module
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModuleInfo {
    #[serde(rename = "type")]
    pub type_name: &'static str,
    pub version: &'static str,
}

pub struct Decoder {
    modules: HashMap<&'static str, Box<dyn Module>>,
    sample_rate: f64,
    resources: HashMap<String, Arc<Audio>>,
}

impl Decoder {
    /// A decoder with the core modules (`sampler`, `sequencer`), rendering at `sample_rate`
    pub fn new(sample_rate: f64) -> Self {
        let mut decoder = Decoder { modules: HashMap::new(), sample_rate, resources: HashMap::new() };
        decoder.register(modules::Sampler).expect("core modules are unique");
        decoder.register(modules::Sequencer).expect("core modules are unique");
        decoder
    }

    /// Adds a module. Its `type` must be a reverse-DNS name (see
    /// [`is_extension_type`]) that isn't already registered.
    pub fn register(&mut self, module: impl Module + 'static) -> Result<&mut Self> {
        let name = module.type_name();
        if !CORE_TYPES.contains(&name) && !is_extension_type(name) {
            return Err(Error::new(
                "",
                format!("extension type \"{name}\" must be a reverse-DNS name, e.g. \"org.example.{name}\""),
            ));
        }
        if parse_version(module.version()).is_none() {
            return Err(Error::new("", format!("{name}'s version must be \"major.minor\", not {}", module.version())));
        }
        if self.modules.contains_key(name) {
            return Err(Error::new("", format!("a module for type \"{name}\" is already registered")));
        }
        self.modules.insert(name, Box::new(module));
        Ok(self)
    }

    pub fn modules(&self) -> Vec<ModuleInfo> {
        let mut info: Vec<_> = self
            .modules
            .values()
            .map(|m| ModuleInfo { type_name: m.type_name(), version: m.version() })
            .collect();
        info.sort_by_key(|m| m.type_name);
        info
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    pub fn parse(&self, json: &str) -> Result<Document> {
        let value: Value = serde_json::from_str(json).map_err(|e| Error::new("", format!("invalid JSON: {e}")))?;
        self.parse_value(&value)
    }

    pub fn parse_value(&self, value: &Value) -> Result<Document> {
        let object = value.as_object().ok_or_else(|| Error::new("", "a document must be a JSON object"))?;
        for key in object.keys() {
            if !matches!(key.as_str(), "$schema" | "format" | "version" | "requires" | "defs" | "root" | "meta") {
                return Err(Error::new(
                    format!("/{}", refs::escape_token(key)),
                    "unknown field; a document has format, version, requires, defs, root and meta",
                ));
            }
        }
        match object.get("format") {
            Some(Value::String(f)) if f == FORMAT => {}
            _ => return Err(Error::new("/format", format!("must be \"{FORMAT}\""))),
        }
        let version = match object.get("version") {
            Some(Value::String(v)) if parse_version(v).is_some() => v.clone(),
            _ => return Err(Error::new("/version", "must be a version string, e.g. \"0.2\"")),
        };
        if !compatible(&version, VERSION) {
            return Err(Error::new("/version", format!("this decoder reads version {VERSION}, not {version}")));
        }
        self.check_requires(object.get("requires"))?;
        match object.get("defs") {
            None | Some(Value::Object(_)) => {}
            Some(_) => return Err(Error::new("/defs", "must be an object of definitions")),
        }
        let root = object.get("root").ok_or_else(|| Error::new("/root", "a document needs a root node"))?;
        let (root, sources) = refs::expand(value, root, "/root")?;
        let cx = ParseContext { modules: &self.modules, sources: &sources };
        let root = cx.parse(&root, "/root".into()).map_err(|e| sources.locate(e))?;
        Ok(Document { version, root })
    }

    /// `"requires": {"org.example.theremin": "0.1"}`: fail up front, and
    /// clearly, when this decoder lacks a module (or a recent enough one)
    fn check_requires(&self, requires: Option<&Value>) -> Result<()> {
        let Some(requires) = requires else { return Ok(()) };
        let requires = requires
            .as_object()
            .ok_or_else(|| Error::new("/requires", "must be an object of type names to versions"))?;
        for (name, wanted) in requires {
            let path = format!("/requires/{}", refs::escape_token(name));
            let wanted = wanted
                .as_str()
                .filter(|v| parse_version(v).is_some())
                .ok_or_else(|| Error::new(&path, "must be a version string, e.g. \"0.1\""))?;
            let module = self
                .modules
                .get(name.as_str())
                .ok_or_else(|| Error::new(&path, format!("this decoder has no module for \"{name}\"")))?;
            if !compatible(wanted, module.version()) {
                return Err(Error::new(
                    &path,
                    format!("needs {name} {wanted}, but this decoder has {}", module.version()),
                ));
            }
        }
        Ok(())
    }

    /// Supplies decoded audio for a URI. It's resampled to the output rate.
    pub fn provide(&mut self, uri: impl Into<String>, audio: Audio) {
        let audio = audio.resampled(self.sample_rate);
        self.resources.insert(uri.into(), Arc::new(audio));
    }

    /// Supplies an encoded file (only WAV is supported natively)
    pub fn provide_bytes(&mut self, uri: impl Into<String>, bytes: &[u8]) -> Result<()> {
        let uri = uri.into();
        let audio = audio::decode_wav(bytes).map_err(|e| Error::new("", format!("{}: {e}", node::display_uri(&uri))))?;
        self.provide(uri, audio);
        Ok(())
    }

    /// Decodes the document's `data:` URIs, which need no I/O
    pub fn provide_data_uris(&mut self, doc: &Document) -> Result<()> {
        for uri in doc.resources() {
            if uri.starts_with("data:") && !self.resources.contains_key(&uri) {
                let bytes = audio::decode_data_uri(&uri)
                    .map_err(|e| Error::new("", format!("{}: {e}", node::display_uri(&uri))))?;
                self.provide_bytes(uri, &bytes)?;
            }
        }
        Ok(())
    }

    /// The document's URIs that haven't been provided yet
    pub fn missing_resources(&self, doc: &Document) -> Vec<String> {
        doc.resources().into_iter().filter(|r| !self.resources.contains_key(r)).collect()
    }

    /// Prepares the whole document for rendering
    pub fn render(&self, doc: &Document) -> Result<Rendering> {
        self.render_node(doc, None)
    }

    /// Prepares one node for rendering *in context*: it plays at the time,
    /// and with the timing, it has in the whole document, with every other
    /// node silent. The rendering is positioned at the node's start.
    pub fn render_node(&self, doc: &Document, solo: Option<&str>) -> Result<Rendering> {
        if let Some(path) = solo {
            if doc.root.find(path).is_none() {
                return Err(Error::new(path, "no node at this path"));
            }
        }
        let missing = self.missing_resources(doc);
        if !missing.is_empty() {
            let list: Vec<_> = missing.iter().map(|m| node::display_uri(m)).collect();
            return Err(Error::new("", format!("resources not loaded: {}", list.join(", "))));
        }
        let layout = RefCell::new(Vec::new());
        let cx = BuildContext {
            sample_rate: self.sample_rate,
            resources: &self.resources,
            layout: &layout,
            solo,
            offset_seconds: 0.0,
            time_scale: 1.0,
        };
        let (_, voice) = cx.build(&doc.root, 0.0, 1.0)?;
        let mut layout = layout.into_inner();
        layout.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds).then_with(|| a.path.cmp(&b.path)));
        let mut rendering = Rendering { voice, layout, sample_rate: self.sample_rate, position: 0, start: 0, end: 0 };
        rendering.end = rendering.voice.frames();
        if let Some(path) = solo {
            if let Some(node) = rendering.layout.iter().find(|n| n.path == path) {
                let start = (node.start_seconds * self.sample_rate).round() as u64;
                let duration = (node.duration_seconds * self.sample_rate).round() as u64;
                rendering.start = start;
                rendering.end = start + duration;
                rendering.seek(start);
            }
        }
        Ok(rendering)
    }
}

/// A document (or node), ready to render
pub struct Rendering {
    voice: Box<dyn Voice>,
    pub layout: Vec<NodeLayout>,
    pub sample_rate: f64,
    position: u64,
    /// The span this rendering covers: the whole document, or one node
    start: u64,
    end: u64,
}

#[derive(Serialize)]
pub struct Description<'a> {
    pub sample_rate: f64,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    pub nodes: &'a [NodeLayout],
}

impl Rendering {
    /// Frames from the current position to the end
    pub fn remaining(&self) -> u64 {
        self.end.saturating_sub(self.position)
    }

    pub fn frames(&self) -> u64 {
        self.end - self.start
    }

    pub fn position(&self) -> u64 {
        self.position
    }

    /// Moves forward to an absolute frame (rendering is one-way)
    pub fn seek(&mut self, frame: u64) {
        if frame > self.position {
            self.voice.skip(frame - self.position);
            self.position = frame;
        }
    }

    /// Overwrites `out` with the next frames; returns how many were real
    /// audio (fewer than `out.len()` at the end, after which `out` is padded with zeros)
    pub fn render(&mut self, out: &mut [f32]) -> usize {
        out.fill(0.0);
        let n = (self.remaining() as usize).min(out.len());
        self.voice.render(&mut out[..n]);
        self.position += n as u64;
        n
    }

    /// Renders everything that's left
    pub fn render_all(&mut self) -> Audio {
        let mut samples = vec![0.0; self.remaining() as usize];
        self.render(&mut samples);
        Audio::new(self.sample_rate, samples)
    }

    pub fn describe(&self) -> Description<'_> {
        Description {
            sample_rate: self.sample_rate,
            start_seconds: self.start as f64 / self.sample_rate,
            duration_seconds: self.frames() as f64 / self.sample_rate,
            nodes: &self.layout,
        }
    }
}

#[cfg(test)]
mod tests;
