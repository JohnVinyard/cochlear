//! Signal processing used by the core modules (and available to extensions)

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interpolation {
    Linear,
    Exponential,
}

/// The quietest gain an exponential ramp can reach (-80 dB). A ramp to or
/// from 0 would otherwise be undefined.
pub const EXPONENTIAL_FLOOR: f64 = 1e-4;

/// Multiplies `samples` by a piecewise gain envelope. `points` are
/// `(seconds, gain)` pairs, sorted by time. Before the first point the gain is
/// the first point's, and after the last it's the last point's.
pub fn apply_envelope(samples: &mut [f32], sample_rate: f64, points: &[(f64, f64)], interpolation: Interpolation) {
    if points.is_empty() {
        return;
    }
    let mut segment = 0;
    for (i, s) in samples.iter_mut().enumerate() {
        let t = i as f64 / sample_rate;
        while segment + 1 < points.len() && points[segment + 1].0 <= t {
            segment += 1;
        }
        let (t0, g0) = points[segment];
        let gain = match points.get(segment + 1) {
            _ if t < t0 => g0,
            None => g0,
            Some(&(t1, g1)) => {
                let frac = if t1 > t0 { (t - t0) / (t1 - t0) } else { 1.0 };
                match interpolation {
                    Interpolation::Linear => g0 + (g1 - g0) * frac,
                    Interpolation::Exponential => {
                        let (a, b) = (g0.max(EXPONENTIAL_FLOOR), g1.max(EXPONENTIAL_FLOOR));
                        a * (b / a).powf(frac)
                    }
                }
            }
        };
        *s = (*s as f64 * gain) as f32;
    }
}

/// A band-pass biquad (RBJ cookbook, 0 dB peak gain)
pub fn bandpass(samples: &mut [f32], sample_rate: f64, center_frequency: f64, bandwidth: f64) {
    let w0 = 2.0 * std::f64::consts::PI * center_frequency / sample_rate;
    let q = center_frequency / bandwidth;
    let alpha = w0.sin() / (2.0 * q);
    let a0 = 1.0 + alpha;
    let (b0, b1, b2) = (alpha / a0, 0.0, -alpha / a0);
    let (a1, a2) = (-2.0 * w0.cos() / a0, (1.0 - alpha) / a0);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    for s in samples.iter_mut() {
        let x0 = *s as f64;
        let y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        (x2, x1, y2, y1) = (x1, x0, y1, y0);
        *s = y0 as f32;
    }
}

/// Scales an impulse response to unit energy, so reverbs of different
/// lengths and levels come out at comparable loudness
pub fn normalize_energy(ir: &[f32]) -> Vec<f32> {
    let energy: f64 = ir.iter().map(|&x| (x as f64) * (x as f64)).sum();
    if energy <= 0.0 {
        return ir.to_vec();
    }
    let scale = 1.0 / energy.sqrt();
    ir.iter().map(|&x| (x as f64 * scale) as f32).collect()
}

/// Full linear convolution (`signal.len() + ir.len() - 1` samples), by FFT
/// overlap-add, so memory stays proportional to the IR, not the signal
pub fn convolve(signal: &[f32], ir: &[f32]) -> Vec<f32> {
    if signal.is_empty() || ir.is_empty() {
        return Vec::new();
    }
    let out_len = signal.len() + ir.len() - 1;
    if ir.len() <= 64 {
        // direct form is faster for tiny kernels
        let mut out = vec![0.0f32; out_len];
        for (i, &x) in signal.iter().enumerate() {
            for (j, &h) in ir.iter().enumerate() {
                out[i + j] += x * h;
            }
        }
        return out;
    }
    let fft_len = (2 * ir.len()).next_power_of_two();
    let block = fft_len - ir.len() + 1;
    let mut planner = FftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(fft_len);
    let inverse = planner.plan_fft_inverse(fft_len);

    let mut kernel: Vec<Complex<f32>> = ir.iter().map(|&h| Complex::new(h, 0.0)).collect();
    kernel.resize(fft_len, Complex::new(0.0, 0.0));
    forward.process(&mut kernel);

    let mut out = vec![0.0f32; out_len];
    let mut buf = vec![Complex::new(0.0, 0.0); fft_len];
    let scale = 1.0 / fft_len as f32;
    for (n, chunk) in signal.chunks(block).enumerate() {
        buf.iter_mut().for_each(|c| *c = Complex::new(0.0, 0.0));
        for (c, &x) in buf.iter_mut().zip(chunk) {
            c.re = x;
        }
        forward.process(&mut buf);
        for (c, k) in buf.iter_mut().zip(&kernel) {
            *c *= k;
        }
        inverse.process(&mut buf);
        let offset = n * block;
        for (i, c) in buf.iter().enumerate().take(chunk.len() + ir.len() - 1) {
            out[offset + i] += c.re * scale;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naive(signal: &[f32], ir: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0; signal.len() + ir.len() - 1];
        for (i, &x) in signal.iter().enumerate() {
            for (j, &h) in ir.iter().enumerate() {
                out[i + j] += x * h;
            }
        }
        out
    }

    #[test]
    fn fft_convolution_matches_direct_convolution() {
        let signal: Vec<f32> = (0..3000).map(|i| ((i * 7919) % 101) as f32 / 101.0 - 0.5).collect();
        let ir: Vec<f32> = (0..300).map(|i| (-(i as f32) / 50.0).exp() * if i % 2 == 0 { 1.0 } else { -0.5 }).collect();
        let (fast, slow) = (convolve(&signal, &ir), naive(&signal, &ir));
        assert_eq!(fast.len(), slow.len());
        for (a, b) in fast.iter().zip(&slow) {
            assert!((a - b).abs() < 1e-3, "{a} vs {b}");
        }
    }

    #[test]
    fn linear_envelope_interpolates_and_holds() {
        let mut s = vec![1.0f32; 5];
        apply_envelope(&mut s, 1.0, &[(1.0, 0.0), (3.0, 1.0)], Interpolation::Linear);
        assert_eq!(s, vec![0.0, 0.0, 0.5, 1.0, 1.0]);
    }

    #[test]
    fn exponential_envelope_is_geometric() {
        let mut s = vec![1.0f32; 3];
        apply_envelope(&mut s, 1.0, &[(0.0, 1.0), (2.0, 0.01)], Interpolation::Exponential);
        assert!((s[1] - 0.1).abs() < 1e-6);
    }

    #[test]
    fn bandpass_passes_its_center_and_rejects_far_frequencies() {
        let rate = 44100.0;
        let tone = |f: f64| -> Vec<f32> {
            (0..44100).map(|i| (2.0 * std::f64::consts::PI * f * i as f64 / rate).sin() as f32).collect()
        };
        let rms = |s: &[f32]| (s[22050..].iter().map(|x| x * x).sum::<f32>() / 22050.0).sqrt();
        let mut center = tone(1000.0);
        bandpass(&mut center, rate, 1000.0, 100.0);
        let mut far = tone(8000.0);
        bandpass(&mut far, rate, 1000.0, 100.0);
        assert!((rms(&center) - 0.707).abs() < 0.02);
        assert!(rms(&far) < 0.02);
    }
}
