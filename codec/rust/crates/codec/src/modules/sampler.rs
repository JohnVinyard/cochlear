//! `sampler`: plays (part of) a sound from a URI, with a little processing.
//!
//! ```json
//! { "type": "sampler",
//!   "url": "https://example.com/snare.wav",
//!   "start_seconds": 0, "duration_seconds": 0.5, "gain": 0.8,
//!   "envelope": { "type": "exponential", "points": [
//!       { "time_seconds": 0, "gain": 1 }, { "time_seconds": 0.5, "gain": 0.001 } ] },
//!   "filter": { "type": "bandpass", "center_frequency": 2000, "bandwidth": 1000 },
//!   "convolve": { "url": "https://example.com/room.wav", "mix": 0.3 } }
//! ```
//!
//! Processing order: slice, envelope, filter, gain, convolve. Envelope times
//! are relative to the start of the slice.

use serde::Deserialize;

use crate::dsp::{self, Interpolation};
use crate::error::Result;
use crate::node::{display_uri, BufferVoice, BuildContext, Module, Node, NodeRef, ParseContext, Voice};

pub struct Sampler;

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Params {
    url: String,
    #[serde(default)]
    start_seconds: f64,
    duration_seconds: Option<f64>,
    #[serde(default = "one")]
    gain: f64,
    envelope: Option<Envelope>,
    filter: Option<Filter>,
    convolve: Option<Convolve>,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Envelope {
    #[serde(rename = "type", default = "linear")]
    interpolation: String,
    points: Vec<Point>,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Point {
    time_seconds: f64,
    gain: f64,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Filter {
    #[serde(rename = "type", default = "bandpass")]
    filter_type: String,
    center_frequency: f64,
    bandwidth: f64,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Convolve {
    url: String,
    mix: f64,
}

fn one() -> f64 {
    1.0
}
fn linear() -> String {
    "linear".into()
}
fn bandpass() -> String {
    "bandpass".into()
}

struct SamplerNode {
    params: Params,
    interpolation: Interpolation,
    path: String,
}

impl Module for Sampler {
    fn type_name(&self) -> &'static str {
        "sampler"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn parse(&self, node: &NodeRef, _cx: &ParseContext) -> Result<Box<dyn Node>> {
        let p: Params = node.params()?;
        let check = |ok: bool, message: &str| if ok { Ok(()) } else { Err(node.error(message)) };
        check(!p.url.is_empty(), "url must not be empty")?;
        check(p.start_seconds.is_finite() && p.start_seconds >= 0.0, "start_seconds must be >= 0")?;
        check(
            p.duration_seconds.is_none_or(|d| d.is_finite() && d >= 0.0),
            "duration_seconds must be >= 0",
        )?;
        check(p.gain.is_finite(), "gain must be a number")?;
        let mut interpolation = Interpolation::Linear;
        if let Some(env) = &p.envelope {
            interpolation = match env.interpolation.as_str() {
                "linear" => Interpolation::Linear,
                "exponential" => Interpolation::Exponential,
                other => return Err(node.error(format!("envelope.type must be linear or exponential, not {other:?}"))),
            };
            check(!env.points.is_empty(), "envelope.points must not be empty")?;
            check(
                env.points.iter().all(|pt| pt.time_seconds.is_finite() && pt.time_seconds >= 0.0 && pt.gain.is_finite()),
                "envelope points need time_seconds >= 0 and a numeric gain",
            )?;
            check(
                env.points.windows(2).all(|w| w[0].time_seconds <= w[1].time_seconds),
                "envelope points must be in time order",
            )?;
        }
        if let Some(f) = &p.filter {
            check(f.filter_type == "bandpass", "filter.type must be bandpass (the only filter so far)")?;
            check(f.center_frequency > 0.0 && f.center_frequency.is_finite(), "filter.center_frequency must be > 0")?;
            check(f.bandwidth > 0.0 && f.bandwidth.is_finite(), "filter.bandwidth must be > 0")?;
        }
        if let Some(c) = &p.convolve {
            check(!c.url.is_empty(), "convolve.url must not be empty")?;
            check((0.0..=1.0).contains(&c.mix), "convolve.mix must be between 0 and 1")?;
        }
        Ok(Box::new(SamplerNode { params: p, interpolation, path: node.path.clone() }))
    }
}

impl Node for SamplerNode {
    fn resources(&self) -> Vec<String> {
        let mut r = vec![self.params.url.clone()];
        if let Some(c) = &self.params.convolve {
            r.push(c.url.clone());
        }
        r
    }

    fn build(&self, cx: &BuildContext) -> Result<Box<dyn Voice>> {
        let err = |m: String| crate::Error::new(self.path.clone(), m);
        let p = &self.params;
        let rate = cx.sample_rate();
        let audio = cx.audio(&p.url).map_err(err)?;

        let start = ((p.start_seconds * rate).round() as usize).min(audio.samples.len());
        if p.start_seconds > 0.0 && start >= audio.samples.len() {
            return Err(err(format!(
                "start_seconds {} is past the end of {} ({:.3}s)",
                p.start_seconds,
                display_uri(&p.url),
                audio.duration_seconds()
            )));
        }
        let end = match p.duration_seconds {
            Some(d) => (start + (d * rate).round() as usize).min(audio.samples.len()),
            None => audio.samples.len(),
        };
        let mut samples = audio.samples[start..end].to_vec();

        if let Some(env) = &p.envelope {
            let points: Vec<_> = env.points.iter().map(|pt| (pt.time_seconds, pt.gain)).collect();
            dsp::apply_envelope(&mut samples, rate, &points, self.interpolation);
        }
        if let Some(f) = &p.filter {
            if f.center_frequency >= rate / 2.0 {
                return Err(err(format!(
                    "filter.center_frequency must be below the Nyquist frequency ({} Hz)",
                    rate / 2.0
                )));
            }
            dsp::bandpass(&mut samples, rate, f.center_frequency, f.bandwidth);
        }
        if p.gain != 1.0 {
            let gain = p.gain as f32;
            samples.iter_mut().for_each(|s| *s *= gain);
        }
        if let Some(c) = &p.convolve {
            let ir = cx.audio(&c.url).map_err(err)?;
            let wet = dsp::convolve(&samples, &dsp::normalize_energy(&ir.samples));
            let mix = c.mix as f32;
            let dry = samples;
            samples = wet
                .iter()
                .enumerate()
                .map(|(i, w)| (1.0 - mix) * dry.get(i).copied().unwrap_or(0.0) + mix * w)
                .collect();
        }
        Ok(Box::new(BufferVoice::new(samples)))
    }
}
