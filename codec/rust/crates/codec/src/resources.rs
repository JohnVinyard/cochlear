//! The audio a host has provided, which may be only parts of each resource.
//!
//! A sampler that plays 0.5 s from the middle of an hour-long recording only
//! needs that half second. Nodes say which parts of each resource they read
//! ([`Node::resource_spans`](crate::node::Node::resource_spans)); the decoder
//! asks the host for just those ([`Decoder::resource_requests`](crate::Decoder::resource_requests));
//! and the host provides them as pieces at offsets
//! ([`Decoder::provide_span`](crate::Decoder::provide_span)), e.g. from HTTP
//! range requests. Everything here is at the decoder's output sample rate.

use std::sync::Arc;

use serde::Serialize;

use crate::audio::Audio;

/// A span of a resource, in seconds from its start. `end_seconds: None` is
/// "to the end".
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Span {
    pub start_seconds: f64,
    pub end_seconds: Option<f64>,
}

impl Span {
    pub const WHOLE: Span = Span { start_seconds: 0.0, end_seconds: None };

    pub fn new(start_seconds: f64, end_seconds: Option<f64>) -> Span {
        Span { start_seconds, end_seconds }
    }
}

/// The parts of one resource a document still needs
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResourceRequest {
    pub uri: String,
    /// In order, not overlapping
    pub spans: Vec<Span>,
}

/// Sorts spans and merges the ones that overlap or touch
pub fn merge_spans(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    let mut out: Vec<Span> = Vec::new();
    for s in spans {
        match out.last_mut() {
            Some(last) if last.end_seconds.is_none_or(|end| s.start_seconds <= end) => {
                last.end_seconds = match (last.end_seconds, s.end_seconds) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    _ => None,
                };
            }
            _ => out.push(s),
        }
    }
    out
}

struct Piece {
    /// Frame (at the output rate) of the resource where this piece starts
    start: usize,
    audio: Arc<Audio>,
}

impl Piece {
    fn end(&self) -> usize {
        self.start + self.audio.samples.len()
    }
}

/// Reading a span within a frame or two of a piece's end is fine: pieces are
/// resampled one by one, so their lengths can round differently from the
/// span's. The missing frames are silence.
const SLOP_FRAMES: usize = 2;

/// What's been provided of one resource
#[derive(Default)]
pub struct Resource {
    pieces: Vec<Piece>,
    /// Its length, when the host said (or provided all of it)
    total_frames: Option<usize>,
}

impl Resource {
    pub(crate) fn whole(audio: Audio) -> Resource {
        let total = audio.samples.len();
        Resource { pieces: vec![Piece { start: 0, audio: Arc::new(audio) }], total_frames: Some(total) }
    }

    pub(crate) fn add(&mut self, start: usize, audio: Audio, total_frames: Option<usize>) {
        self.pieces.push(Piece { start, audio: Arc::new(audio) });
        if total_frames.is_some() {
            self.total_frames = total_frames;
        }
    }

    /// The resource's length in frames: as the host said, else as far as it's loaded
    pub fn frames(&self) -> usize {
        self.total_frames.unwrap_or_else(|| self.pieces.iter().map(Piece::end).max().unwrap_or(0))
    }

    /// Frames `[start, end)`, clamped to the resource's length
    fn frame_range(&self, span: Span, rate: f64) -> (usize, Option<usize>) {
        let clamp = |f: usize| self.total_frames.map_or(f, |t| f.min(t));
        let start = clamp((span.start_seconds * rate).floor().max(0.0) as usize);
        let end = span.end_seconds.map(|e| clamp((e * rate).ceil().max(0.0) as usize)).or(self.total_frames);
        (start, end.map(|e| e.max(start)))
    }

    /// The piece holding frames `[start, end)`, if one does
    fn piece_for(&self, start: usize, end: usize) -> Option<&Piece> {
        self.pieces.iter().find(|p| p.start <= start && end <= p.end() + SLOP_FRAMES)
    }

    pub(crate) fn covers(&self, span: Span, rate: f64) -> bool {
        match self.frame_range(span, rate) {
            (start, Some(end)) => start == end || self.piece_for(start, end).is_some(),
            // "to the end" of a resource whose end isn't known
            (_, None) => false,
        }
    }

    /// Frames `[start, end)`, which the caller has clamped to [`frames`](Self::frames)
    pub fn read(&self, start: usize, end: usize) -> Option<Vec<f32>> {
        if start >= end {
            return Some(Vec::new());
        }
        let piece = self.piece_for(start, end)?;
        let samples = &piece.audio.samples;
        let from = start - piece.start;
        let to = (end - piece.start).min(samples.len());
        let mut out = samples[from.min(to)..to].to_vec();
        out.resize(end - start, 0.0);
        Some(out)
    }

    /// All of it, if all of it has been provided
    pub fn whole_audio(&self) -> Option<Arc<Audio>> {
        let total = self.frames();
        self.pieces.iter().find(|p| p.start == 0 && p.end() + SLOP_FRAMES >= total).map(|p| p.audio.clone())
    }
}
