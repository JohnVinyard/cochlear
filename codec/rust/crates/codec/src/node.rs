//! How modules plug in. A **module** (the `sampler`, the `sequencer`, or an
//! extension such as `org.cochlea.gammatone`) is registered under a `type` name. Decoding
//! happens in three phases, which keeps hosts in control of I/O:
//!
//! 1. **parse**: each module turns its JSON node into a [`Node`], validating
//!    everything and parsing its children through [`ParseContext::parse`];
//! 2. **resources**: the host asks the document which URIs it needs, then
//!    fetches and decodes them however it likes (`fetch` + `decodeAudioData`
//!    in a browser, files or HTTP in a CLI);
//! 3. **build**: each node becomes a [`Voice`], which renders samples.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::audio::Audio;
use crate::error::{Error, Result};
use crate::refs::Sources;

/// Keys every node may have, whatever its type
pub const COMMON_KEYS: [&str; 3] = ["type", "label", "meta"];

/// A registered node type
pub trait Module: Send + Sync {
    /// The `type` this module handles, e.g. `"sampler"`
    fn type_name(&self) -> &'static str;
    /// The version of the node format this module implements
    fn version(&self) -> &'static str;
    fn parse(&self, node: &NodeRef, cx: &ParseContext) -> Result<Box<dyn Node>>;
}

/// A parsed, validated node
pub trait Node: Send + Sync {
    /// URIs of audio this node (not its children) needs
    fn resources(&self) -> Vec<String> {
        Vec::new()
    }
    /// Child nodes, for walking the tree
    fn children(&self) -> Vec<&Child> {
        Vec::new()
    }
    fn build(&self, cx: &BuildContext) -> Result<Box<dyn Voice>>;
}

/// Something that renders samples, once, from start to finish
pub trait Voice: Send {
    /// Total length in frames
    fn frames(&self) -> u64;
    /// *Adds* the next `out.len()` frames into `out`. Rendering past the end adds nothing.
    fn render(&mut self, out: &mut [f32]);
    /// Skips the next `frames` frames. Override it if there's something cheaper than rendering them.
    fn skip(&mut self, frames: u64) {
        let mut scratch = vec![0.0; 4096];
        let mut left = frames;
        while left > 0 {
            let n = left.min(scratch.len() as u64) as usize;
            self.render(&mut scratch[..n]);
            scratch[..n].fill(0.0);
            left -= n as u64;
        }
    }
}

/// A voice that plays a precomputed buffer. Most leaf modules can render
/// their whole output up front and return one of these.
pub struct BufferVoice {
    samples: Arc<Vec<f32>>,
    position: usize,
}

impl BufferVoice {
    pub fn new(samples: Vec<f32>) -> Self {
        BufferVoice { samples: Arc::new(samples), position: 0 }
    }
}

impl Voice for BufferVoice {
    fn frames(&self) -> u64 {
        self.samples.len() as u64
    }
    fn render(&mut self, out: &mut [f32]) {
        let end = (self.position + out.len()).min(self.samples.len());
        for (o, s) in out.iter_mut().zip(&self.samples[self.position.min(end)..end]) {
            *o += s;
        }
        self.position += out.len();
    }
    fn skip(&mut self, frames: u64) {
        self.position = self.position.saturating_add(frames as usize);
    }
}

/// A raw JSON node, with its location in the document
pub struct NodeRef<'a> {
    pub path: String,
    pub value: &'a Value,
}

impl NodeRef<'_> {
    pub fn object(&self) -> Result<&Map<String, Value>> {
        self.value.as_object().ok_or_else(|| self.error("a node must be an object"))
    }

    /// The node's own parameters (everything except `type`, `label` and
    /// `meta`), deserialized. Use `#[serde(deny_unknown_fields)]`, so typos
    /// are errors rather than silently ignored.
    pub fn params<T: DeserializeOwned>(&self) -> Result<T> {
        let mut object = self.object()?.clone();
        for key in COMMON_KEYS {
            object.remove(key);
        }
        serde_json::from_value(Value::Object(object)).map_err(|e| self.error(e.to_string()))
    }

    pub fn error(&self, message: impl Into<String>) -> Error {
        Error::new(self.path.clone(), message)
    }

    /// A pointer to something inside this node, e.g. `node.pointer("events/3")`
    pub fn pointer(&self, suffix: &str) -> String {
        format!("{}/{}", self.path, suffix)
    }
}

/// A parsed child node, as held by its parent
pub struct Child {
    /// Where the node is in the (expanded) tree. Unique.
    pub path: String,
    /// Where its JSON is in the document: the same as `path`, unless it's
    /// inside something that was referenced, e.g. `/defs/four-kicks`
    pub source: String,
    /// The `$ref` that stood in for this node, if one did
    pub reference: Option<String>,
    pub type_name: String,
    pub label: Option<String>,
    node: Box<dyn Node>,
}

impl Child {
    pub fn node(&self) -> &dyn Node {
        self.node.as_ref()
    }

    /// Every URI this subtree needs, in document order, without duplicates
    pub fn resources(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.collect_resources(&mut out);
        out
    }

    fn collect_resources(&self, out: &mut Vec<String>) {
        for r in self.node.resources() {
            if !out.contains(&r) {
                out.push(r);
            }
        }
        for c in self.node.children() {
            c.collect_resources(out);
        }
    }

    /// Finds a node in this subtree by its JSON Pointer
    pub fn find(&self, path: &str) -> Option<&Child> {
        if self.path == path {
            return Some(self);
        }
        self.node.children().into_iter().find_map(|c| c.find(path))
    }
}

pub struct ParseContext<'a> {
    pub(crate) modules: &'a HashMap<&'static str, Box<dyn Module>>,
    pub(crate) sources: &'a Sources,
}

impl ParseContext<'_> {
    /// Parses a child node, dispatching on its `type`
    pub fn parse(&self, value: &Value, path: String) -> Result<Child> {
        let node = NodeRef { path, value };
        let object = node.object()?;
        let type_name = match object.get("type") {
            Some(Value::String(t)) => t.clone(),
            Some(_) => return Err(node.error("\"type\" must be a string")),
            None => return Err(node.error("a node needs a \"type\"")),
        };
        let module = self.modules.get(type_name.as_str()).ok_or_else(|| {
            let mut known: Vec<_> = self.modules.keys().copied().collect();
            known.sort();
            node.error(format!(
                "unknown type \"{type_name}\"; this decoder supports {}",
                known.join(", ")
            ))
        })?;
        let label = match object.get("label") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return Err(node.error("\"label\" must be a string")),
        };
        if let Some(meta) = object.get("meta") {
            if !meta.is_object() {
                return Err(node.error("\"meta\" must be an object"));
            }
        }
        let parsed = module.parse(&node, self)?;
        Ok(Child {
            source: self.sources.source(&node.path),
            reference: self.sources.reference(&node.path),
            path: node.path,
            type_name,
            label,
            node: parsed,
        })
    }
}

/// Where and when one node plays, for viewers
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NodeLayout {
    pub path: String,
    pub source: String,
    pub reference: Option<String>,
    #[serde(rename = "type")]
    pub type_name: String,
    pub label: Option<String>,
    pub start_seconds: f64,
    pub duration_seconds: f64,
}

pub struct BuildContext<'a> {
    pub(crate) sample_rate: f64,
    pub(crate) resources: &'a HashMap<String, Arc<Audio>>,
    pub(crate) layout: &'a RefCell<Vec<NodeLayout>>,
    /// When set, only this node (and its ancestors, for timing) makes sound
    pub(crate) solo: Option<&'a str>,
    /// Absolute start time of the node being built, in seconds
    pub(crate) offset_seconds: f64,
    /// Output seconds per second of this node's own timeline (product of
    /// `1 / speed` over the enclosing sequencers)
    pub(crate) time_scale: f64,
}

impl BuildContext<'_> {
    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// When this node starts, in seconds from the start of the document
    pub fn offset_seconds(&self) -> f64 {
        self.offset_seconds
    }

    pub fn time_scale(&self) -> f64 {
        self.time_scale
    }

    /// Decoded audio for a URI (at the output sample rate)
    pub fn audio(&self, uri: &str) -> std::result::Result<Arc<Audio>, String> {
        self.resources.get(uri).cloned().ok_or_else(|| {
            format!("{} hasn't been loaded", display_uri(uri))
        })
    }

    /// Absolute output frame for a time in seconds
    pub fn frame(&self, seconds: f64) -> u64 {
        (seconds * self.sample_rate).round().max(0.0) as u64
    }

    /// Builds a child that starts `offset_seconds` (in *output* seconds) after
    /// this node, with the given time scale. Returns the voice, and its start
    /// frame relative to this node.
    pub fn build(&self, child: &Child, offset_seconds: f64, time_scale: f64) -> Result<(u64, Box<dyn Voice>)> {
        let start = self.offset_seconds + offset_seconds;
        let relative_frame = self.frame(start).saturating_sub(self.frame(self.offset_seconds));
        if let Some(solo) = self.solo {
            let related = child.path == solo
                || solo.starts_with(&format!("{}/", child.path))
                || child.path.starts_with(&format!("{solo}/"));
            if !related {
                return Ok((relative_frame, Box::new(BufferVoice::new(Vec::new()))));
            }
        }
        let cx = BuildContext { offset_seconds: start, time_scale, ..*self };
        let voice = child.node.build(&cx)?;
        self.layout.borrow_mut().push(NodeLayout {
            path: child.path.clone(),
            source: child.source.clone(),
            reference: child.reference.clone(),
            type_name: child.type_name.clone(),
            label: child.label.clone(),
            start_seconds: start,
            duration_seconds: voice.frames() as f64 / self.sample_rate,
        });
        Ok((relative_frame, voice))
    }
}

/// Data URIs can be enormous; error messages show only their start
pub fn display_uri(uri: &str) -> String {
    if uri.len() > 64 {
        format!("{}…", &uri[..uri.char_indices().nth(48).map(|(i, _)| i).unwrap_or(uri.len())])
    } else {
        uri.to_string()
    }
}
