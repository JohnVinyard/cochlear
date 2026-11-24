//! `org.cochlea.gammatone`: an example extension, and the template for writing one.
//!
//! A gammatone is the impulse response of the classic auditory filter:
//! `t^(n-1) · e^(-2πbt) · cos(2πft + φ)`. It's a short, pitched "blip" that
//! decays at a rate set by its bandwidth.
//!
//! ```json
//! { "type": "org.cochlea.gammatone", "center_frequency": 440, "gain": 0.5 }
//! ```
//!
//! | field | default | |
//! |---|---|---|
//! | `center_frequency` | required | Hz, below the Nyquist frequency |
//! | `bandwidth` | `1.019 · ERB(f)` | Hz; larger decays faster. `ERB(f) = 24.7 + 0.108f` (Glasberg & Moore) |
//! | `order` | 4 | 1–10 |
//! | `phase` | 0 | radians |
//! | `gain` | 1 | peak amplitude |
//! | `duration_seconds` | until -60 dB | at most 10s |
//!
//! Registering it:
//!
//! ```
//! let mut decoder = cochlea_codec::Decoder::new(44100.0);
//! decoder.register(cochlea_codec_gammatone::Gammatone).unwrap();
//! ```

use std::f64::consts::PI;

use cochlea_codec::{BufferVoice, BuildContext, Module, Node, NodeRef, ParseContext, Result, Voice};
use serde::Deserialize;

pub struct Gammatone;

pub const MAX_DURATION_SECONDS: f64 = 10.0;
/// Where the default duration ends: -60 dB below the peak
const DECAY_THRESHOLD: f64 = 1e-3;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Params {
    center_frequency: f64,
    bandwidth: Option<f64>,
    #[serde(default = "four")]
    order: u32,
    #[serde(default)]
    phase: f64,
    #[serde(default = "one")]
    gain: f64,
    duration_seconds: Option<f64>,
}

fn four() -> u32 {
    4
}
fn one() -> f64 {
    1.0
}

/// Equivalent rectangular bandwidth of the human auditory filter at `f` Hz
pub fn erb(f: f64) -> f64 {
    24.7 + 0.108 * f
}

struct GammatoneNode {
    frequency: f64,
    bandwidth: f64,
    order: u32,
    phase: f64,
    gain: f64,
    duration_seconds: Option<f64>,
    path: String,
}

impl Module for Gammatone {
    fn type_name(&self) -> &'static str {
        "org.cochlea.gammatone"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    // 1. parse and validate the node's JSON; nothing here may do I/O
    fn parse(&self, node: &NodeRef, _cx: &ParseContext) -> Result<Box<dyn Node>> {
        let p: Params = node.params()?;
        if !(p.center_frequency.is_finite() && p.center_frequency > 0.0) {
            return Err(node.error("center_frequency must be > 0"));
        }
        let bandwidth = p.bandwidth.unwrap_or_else(|| 1.019 * erb(p.center_frequency));
        if !(bandwidth.is_finite() && bandwidth > 0.0) {
            return Err(node.error("bandwidth must be > 0"));
        }
        if !(1..=10).contains(&p.order) {
            return Err(node.error("order must be between 1 and 10"));
        }
        if !p.phase.is_finite() || !p.gain.is_finite() {
            return Err(node.error("phase and gain must be numbers"));
        }
        if let Some(d) = p.duration_seconds {
            if !(d.is_finite() && (0.0..=MAX_DURATION_SECONDS).contains(&d)) {
                return Err(node.error(format!("duration_seconds must be between 0 and {MAX_DURATION_SECONDS}")));
            }
        }
        Ok(Box::new(GammatoneNode {
            frequency: p.center_frequency,
            bandwidth,
            order: p.order,
            phase: p.phase,
            gain: p.gain,
            duration_seconds: p.duration_seconds,
            path: node.path.clone(),
        }))
    }
}

impl GammatoneNode {
    fn envelope(&self, t: f64) -> f64 {
        t.powi(self.order as i32 - 1) * (-2.0 * PI * self.bandwidth * t).exp()
    }

    fn default_duration(&self) -> f64 {
        let peak_t = (self.order as f64 - 1.0) / (2.0 * PI * self.bandwidth);
        let peak = self.envelope(peak_t).max(f64::MIN_POSITIVE);
        let step = 1e-3;
        let mut t = peak_t;
        while t < MAX_DURATION_SECONDS && self.envelope(t) / peak > DECAY_THRESHOLD {
            t += step;
        }
        t.min(MAX_DURATION_SECONDS)
    }
}

// 2. a node that needs audio would list its URIs in `resources()`; this one
//    synthesises everything, so the default (none) is right
impl Node for GammatoneNode {
    // 3. render. Precomputing the whole (short) sound and returning a
    //    `BufferVoice` is the simplest way; long or endless sounds would
    //    implement `Voice` and render block by block.
    fn build(&self, cx: &BuildContext) -> Result<Box<dyn Voice>> {
        let rate = cx.sample_rate();
        if self.frequency >= rate / 2.0 {
            return Err(cochlea_codec::Error::new(
                self.path.clone(),
                format!("center_frequency must be below the Nyquist frequency ({} Hz)", rate / 2.0),
            ));
        }
        let duration = self.duration_seconds.unwrap_or_else(|| self.default_duration());
        let frames = (duration * rate).round() as usize;
        let mut samples: Vec<f64> = (0..frames)
            .map(|i| {
                let t = i as f64 / rate;
                self.envelope(t) * (2.0 * PI * self.frequency * t + self.phase).cos()
            })
            .collect();
        let peak = samples.iter().fold(0.0f64, |m, s| m.max(s.abs()));
        if peak > 0.0 {
            let scale = self.gain / peak;
            samples.iter_mut().for_each(|s| *s *= scale);
        }
        Ok(Box::new(BufferVoice::new(samples.into_iter().map(|s| s as f32).collect())))
    }
}

#[cfg(test)]
mod tests {
    use cochlea_codec::Decoder;
    use serde_json::json;

    use super::*;

    fn render(node: serde_json::Value) -> Result<Vec<f32>> {
        let mut d = Decoder::new(16000.0);
        d.register(Gammatone)?;
        let doc = d.parse_value(&json!({ "format": "cochlea-codec", "version": "0.2", "root": node }))?;
        Ok(d.render(&doc)?.render_all().samples)
    }

    #[test]
    fn peaks_at_gain_and_decays() {
        let s = render(json!({ "type": "org.cochlea.gammatone", "center_frequency": 1000, "gain": 0.5 })).unwrap();
        let peak = s.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((peak - 0.5).abs() < 1e-6);
        let tail = s[s.len() - 20..].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(tail < 0.5 * 2e-3, "tail {tail}");
        // default ERB bandwidth at 1kHz is ~135Hz, so it rings for ~tens of ms
        assert!(s.len() > 16000 / 100 && s.len() < 16000 / 5, "{} frames", s.len());
    }

    #[test]
    fn honours_an_explicit_duration() {
        let s = render(json!({ "type": "org.cochlea.gammatone", "center_frequency": 200, "duration_seconds": 0.25 })).unwrap();
        assert_eq!(s.len(), 4000);
    }

    #[test]
    fn validates() {
        let e = render(json!({ "type": "org.cochlea.gammatone", "center_frequency": 9000 })).unwrap_err();
        assert!(e.message.contains("Nyquist"), "{e}");
        let e = render(json!({ "type": "org.cochlea.gammatone", "center_frequency": 100, "order": 0 })).unwrap_err();
        assert!(e.message.contains("order"), "{e}");
    }

    #[test]
    fn is_unknown_until_registered() {
        let d = Decoder::new(16000.0);
        let e = d
            .parse_value(&json!({ "format": "cochlea-codec", "version": "0.2", "root": { "type": "org.cochlea.gammatone", "center_frequency": 1 } }))
            .err()
            .unwrap();
        assert!(e.message.contains("unknown type \"org.cochlea.gammatone\""));
    }
}
