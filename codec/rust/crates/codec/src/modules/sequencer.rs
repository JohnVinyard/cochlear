//! `sequencer`: plays child nodes at given times.
//!
//! ```json
//! { "type": "sequencer", "speed": 2, "events": [
//!     { "time_seconds": 0,   "node": { "type": "sampler", "url": "kick.wav" } },
//!     { "time_seconds": 0.5, "node": { "type": "sampler", "url": "snare.wav" } }
//! ] }
//! ```
//!
//! `speed` scales this sequencer's timeline, and so every sequencer nested
//! inside it: at speed 2, an event at `time_seconds: 1` plays half a second
//! after the sequencer starts. It changes *when* things play, not how they
//! sound: samples aren't pitched or stretched.

use serde::Deserialize;
use serde_json::Value;

use crate::error::Result;
use crate::node::{BuildContext, Child, Module, Node, NodeRef, ParseContext, Voice};

pub struct Sequencer;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Params {
    #[serde(default = "one")]
    speed: f64,
    #[serde(default)]
    events: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EventParams {
    time_seconds: f64,
    node: Value,
}

fn one() -> f64 {
    1.0
}

struct Event {
    time_seconds: f64,
    child: Child,
}

struct SequencerNode {
    speed: f64,
    events: Vec<Event>,
}

impl Module for Sequencer {
    fn type_name(&self) -> &'static str {
        "sequencer"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn parse(&self, node: &NodeRef, cx: &ParseContext) -> Result<Box<dyn Node>> {
        let params: Params = node.params()?;
        if !(params.speed.is_finite() && params.speed > 0.0) {
            return Err(node.error("speed must be a positive number"));
        }
        let mut events = Vec::with_capacity(params.events.len());
        for (i, event) in params.events.iter().enumerate() {
            let event_ref = NodeRef { path: node.pointer(&format!("events/{i}")), value: event };
            let e: EventParams = serde_json::from_value(event.clone())
                .map_err(|err| event_ref.error(err.to_string()))?;
            if !(e.time_seconds.is_finite() && e.time_seconds >= 0.0) {
                return Err(event_ref.error("time_seconds must be a number >= 0"));
            }
            let child = cx.parse(&e.node, event_ref.pointer("node"))?;
            events.push(Event { time_seconds: e.time_seconds, child });
        }
        Ok(Box::new(SequencerNode { speed: params.speed, events }))
    }
}

impl Node for SequencerNode {
    fn children(&self) -> Vec<&Child> {
        self.events.iter().map(|e| &e.child).collect()
    }

    fn build(&self, cx: &BuildContext) -> Result<Box<dyn Voice>> {
        let scale = cx.time_scale() / self.speed;
        let mut children = Vec::with_capacity(self.events.len());
        for event in &self.events {
            let (start, voice) = cx.build(&event.child, event.time_seconds * scale, scale)?;
            if voice.frames() > 0 {
                children.push(Scheduled { start, voice });
            }
        }
        children.sort_by_key(|c| c.start);
        let frames = children.iter().map(|c| c.start + c.voice.frames()).max().unwrap_or(0);
        Ok(Box::new(SequencerVoice { children, frames, position: 0, next: 0, active: Vec::new() }))
    }
}

struct Scheduled {
    /// Start frame, relative to the sequencer
    start: u64,
    voice: Box<dyn Voice>,
}

struct SequencerVoice {
    /// Sorted by start
    children: Vec<Scheduled>,
    frames: u64,
    position: u64,
    /// Index of the first child that hasn't started yet
    next: usize,
    /// Indices of children that have started but not finished
    active: Vec<usize>,
}

impl SequencerVoice {
    fn advance(&mut self, len: u64, mut out: Option<&mut [f32]>) {
        let block_end = self.position + len;
        while self.next < self.children.len() && self.children[self.next].start < block_end {
            self.active.push(self.next);
            self.next += 1;
        }
        let position = self.position;
        let children = &mut self.children;
        self.active.retain(|&i| {
            let child = &mut children[i];
            let child_end = child.start + child.voice.frames();
            // where in this block the child's next frames go
            let from = child.start.max(position);
            let to = child_end.min(block_end);
            if from < to {
                let (a, b) = ((from - position) as usize, (to - position) as usize);
                match out.as_deref_mut() {
                    Some(out) => child.voice.render(&mut out[a..b]),
                    None => child.voice.skip(to - from),
                }
            }
            child_end > block_end
        });
        self.position = block_end;
    }
}

impl Voice for SequencerVoice {
    fn frames(&self) -> u64 {
        self.frames
    }

    fn render(&mut self, out: &mut [f32]) {
        self.advance(out.len() as u64, Some(out));
    }

    fn skip(&mut self, frames: u64) {
        self.advance(frames, None);
    }
}
