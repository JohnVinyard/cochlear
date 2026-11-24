//! Decoded audio, and the formats the core decoder can read by itself:
//! WAV files, and `data:` URIs that contain them.

/// Mono audio at a known sample rate. Multi-channel sources are mixed down
/// when they're decoded.
#[derive(Debug, Clone, PartialEq)]
pub struct Audio {
    pub sample_rate: f64,
    pub samples: Vec<f32>,
}

impl Audio {
    pub fn new(sample_rate: f64, samples: Vec<f32>) -> Self {
        Audio { sample_rate, samples }
    }

    pub fn duration_seconds(&self) -> f64 {
        self.samples.len() as f64 / self.sample_rate
    }

    /// Linear-interpolation resampling. Cheap, and good enough for a first draft.
    pub fn resampled(&self, sample_rate: f64) -> Audio {
        if (self.sample_rate - sample_rate).abs() < f64::EPSILON || self.samples.is_empty() {
            return Audio::new(sample_rate, self.samples.clone());
        }
        let ratio = self.sample_rate / sample_rate;
        let frames = ((self.samples.len() as f64) / ratio).floor() as usize;
        let last = self.samples.len() - 1;
        let samples = (0..frames)
            .map(|i| {
                let x = i as f64 * ratio;
                let j = x.floor() as usize;
                let frac = (x - j as f64) as f32;
                let a = self.samples[j.min(last)];
                let b = self.samples[(j + 1).min(last)];
                a + (b - a) * frac
            })
            .collect();
        Audio::new(sample_rate, samples)
    }
}

/// Decodes a RIFF/WAVE file: 8/16/24/32-bit integer PCM, or 32/64-bit float.
pub fn decode_wav(bytes: &[u8]) -> Result<Audio, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let mut pos = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None; // (tag, channels, rate, bits)
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body_start = pos + 8;
        let body_end = (body_start + size).min(bytes.len());
        let body = &bytes[body_start..body_end];
        if id == b"fmt " {
            if body.len() < 16 {
                return Err("truncated fmt chunk".into());
            }
            let mut tag = u16::from_le_bytes([body[0], body[1]]);
            let channels = u16::from_le_bytes([body[2], body[3]]);
            let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let bits = u16::from_le_bytes([body[14], body[15]]);
            if tag == 0xFFFE && body.len() >= 26 {
                // WAVE_FORMAT_EXTENSIBLE: the real tag is the start of the sub-format GUID
                tag = u16::from_le_bytes([body[24], body[25]]);
            }
            format = Some((tag, channels, rate, bits));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = format.ok_or("data chunk before fmt chunk")?;
            return decode_samples(body, tag, channels, rate, bits);
        }
        pos = body_start + size + (size & 1);
    }
    Err("no data chunk".into())
}

fn decode_samples(data: &[u8], tag: u16, channels: u16, rate: u32, bits: u16) -> Result<Audio, String> {
    if channels == 0 || rate == 0 {
        return Err("invalid fmt chunk".into());
    }
    let width = (bits as usize).div_ceil(8);
    let sample: fn(&[u8]) -> f32 = match (tag, bits) {
        (1, 8) => |b| (b[0] as f32 - 128.0) / 128.0,
        (1, 16) => |b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
        (1, 24) => |b| (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
        (1, 32) => |b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
        (3, 32) => |b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        (3, 64) => |b| f64::from_le_bytes(b[0..8].try_into().unwrap()) as f32,
        _ => return Err(format!("unsupported WAV encoding (format {tag}, {bits} bits)")),
    };
    let frame_width = width * channels as usize;
    let frames = data.len() / frame_width;
    let samples = (0..frames)
        .map(|f| {
            let frame = &data[f * frame_width..(f + 1) * frame_width];
            let sum: f32 = frame.chunks_exact(width).map(sample).sum();
            sum / channels as f32
        })
        .collect();
    Ok(Audio::new(rate as f64, samples))
}

/// Decodes a `data:[<mediatype>][;base64],<data>` URI into its bytes
pub fn decode_data_uri(uri: &str) -> Result<Vec<u8>, String> {
    let rest = uri.strip_prefix("data:").ok_or("not a data: URI")?;
    let (meta, data) = rest.split_once(',').ok_or("data: URI has no ','")?;
    if meta.split(';').any(|p| p.eq_ignore_ascii_case("base64")) {
        decode_base64(data)
    } else {
        percent_decode(data)
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in input.as_bytes() {
        if c == b'=' {
            break;
        }
        if c.is_ascii_whitespace() {
            continue;
        }
        let v = value(c).ok_or_else(|| format!("invalid base64 character {:?}", c as char))?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

fn percent_decode(input: &str) -> Result<Vec<u8>, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = input.get(i + 1..i + 3).ok_or("truncated percent-encoding")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "invalid percent-encoding")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Ok(out)
}

/// Encodes mono samples as a 16-bit PCM WAV file
pub fn encode_wav_pcm16(audio: &Audio) -> Vec<u8> {
    let data_len = audio.samples.len() * 2;
    let rate = audio.sample_rate.round() as u32;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for s in &audio.samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_pcm16_wav() {
        let audio = Audio::new(8000.0, vec![0.0, 0.5, -0.5, 1.0]);
        let decoded = decode_wav(&encode_wav_pcm16(&audio)).unwrap();
        assert_eq!(decoded.sample_rate, 8000.0);
        for (a, b) in decoded.samples.iter().zip(&audio.samples) {
            assert!((a - b).abs() < 1e-4, "{a} vs {b}");
        }
    }

    #[test]
    fn skips_unknown_chunks_and_mixes_down() {
        let mut wav = b"RIFF\0\0\0\0WAVE".to_vec();
        wav.extend_from_slice(b"smpl\x03\0\0\0abc\0"); // odd-sized chunk, padded
        wav.extend_from_slice(b"fmt \x10\0\0\0");
        wav.extend_from_slice(&3u16.to_le_bytes()); // float
        wav.extend_from_slice(&2u16.to_le_bytes()); // stereo
        wav.extend_from_slice(&100u32.to_le_bytes());
        wav.extend_from_slice(&800u32.to_le_bytes());
        wav.extend_from_slice(&8u16.to_le_bytes());
        wav.extend_from_slice(&32u16.to_le_bytes());
        wav.extend_from_slice(b"data\x08\0\0\0");
        wav.extend_from_slice(&1.0f32.to_le_bytes());
        wav.extend_from_slice(&0.0f32.to_le_bytes());
        let audio = decode_wav(&wav).unwrap();
        assert_eq!(audio.samples, vec![0.5]);
    }

    #[test]
    fn decodes_data_uris() {
        assert_eq!(decode_data_uri("data:audio/wav;base64,UklGRg==").unwrap(), b"RIFF");
        assert_eq!(decode_data_uri("data:,a%20b").unwrap(), b"a b");
        assert!(decode_data_uri("https://x").is_err());
    }

    #[test]
    fn resamples_linearly() {
        let audio = Audio::new(2.0, vec![0.0, 1.0, 0.0, 1.0]);
        let up = audio.resampled(4.0);
        assert_eq!(up.samples.len(), 8);
        assert_eq!(&up.samples[..3], &[0.0, 0.5, 1.0]);
    }
}
