//! Renders cochlea codec documents to WAV files.
//!
//!     cochlea-codec render <doc.json> <out.wav> [--sample-rate 44100] [--node /root/events/0/node]
//!     cochlea-codec describe <doc.json> [--sample-rate 44100]
//!     cochlea-codec resources <doc.json>
//!     cochlea-codec modules
//!
//! URIs can be `data:` URIs, `http(s)://` URLs, `file://` URLs, or paths
//! relative to the document. Only WAV audio is supported.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use cochlea_codec::audio::encode_wav_pcm16;
use cochlea_codec::{Decoder, Document};

const USAGE: &str = "usage:
  cochlea-codec render <doc.json> <out.wav> [--sample-rate 44100] [--node <json pointer>]
  cochlea-codec describe <doc.json> [--sample-rate 44100]
  cochlea-codec resources <doc.json>
  cochlea-codec modules";

struct Args {
    positional: Vec<String>,
    sample_rate: f64,
    node: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args { positional: Vec::new(), sample_rate: 44100.0, node: None };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--sample-rate" => {
                let v = it.next().ok_or("--sample-rate needs a value")?;
                args.sample_rate = v.parse().map_err(|_| format!("bad sample rate {v:?}"))?;
            }
            "--node" => args.node = Some(it.next().ok_or("--node needs a JSON pointer")?),
            "-h" | "--help" => return Err(String::new()),
            _ if a.starts_with("--") => return Err(format!("unknown option {a}")),
            _ => args.positional.push(a),
        }
    }
    Ok(args)
}

fn load(path: &str, decoder: &mut Decoder) -> Result<Document, String> {
    let json = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    decoder.parse(&json).map_err(|e| format!("{path}: {e}"))
}

fn fetch(uri: &str, base: &Path) -> Result<Vec<u8>, String> {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        let resp = ureq::get(uri).call().map_err(|e| format!("{uri}: {e}"))?;
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut resp.into_reader(), &mut bytes).map_err(|e| format!("{uri}: {e}"))?;
        return Ok(bytes);
    }
    let path: PathBuf = match uri.strip_prefix("file://") {
        Some(p) => p.into(),
        None => base.join(uri),
    };
    std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))
}

fn load_resources(doc: &Document, doc_path: &str, decoder: &mut Decoder) -> Result<(), String> {
    decoder.provide_data_uris(doc).map_err(|e| e.to_string())?;
    let base = Path::new(doc_path).parent().unwrap_or(Path::new("."));
    for uri in decoder.missing_resources(doc) {
        eprintln!("fetching {uri}");
        let bytes = fetch(&uri, base)?;
        decoder.provide_bytes(uri, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let mut decoder = cochlea_codec_wasm::decoder(args.sample_rate);
    let pos: Vec<&str> = args.positional.iter().map(String::as_str).collect();
    match pos.as_slice() {
        ["modules"] => {
            for m in decoder.modules() {
                println!("{}@{}", m.type_name, m.version);
            }
        }
        ["resources", doc_path] => {
            for r in load(doc_path, &mut decoder)?.resources() {
                println!("{r}");
            }
        }
        ["describe", doc_path] => {
            let doc = load(doc_path, &mut decoder)?;
            load_resources(&doc, doc_path, &mut decoder)?;
            let rendering = decoder.render(&doc).map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&rendering.describe()).unwrap());
        }
        ["render", doc_path, out] => {
            let doc = load(doc_path, &mut decoder)?;
            load_resources(&doc, doc_path, &mut decoder)?;
            let mut rendering = decoder.render_node(&doc, args.node.as_deref()).map_err(|e| e.to_string())?;
            let audio = rendering.render_all();
            let peak = audio.samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            std::fs::write(out, encode_wav_pcm16(&audio)).map_err(|e| format!("{out}: {e}"))?;
            eprintln!("wrote {out}: {:.2}s, peak {:.2}{}", audio.duration_seconds(), peak,
                if peak > 1.0 { " (clipped)" } else { "" });
        }
        _ => return Err(String::new()),
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if e.is_empty() => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
