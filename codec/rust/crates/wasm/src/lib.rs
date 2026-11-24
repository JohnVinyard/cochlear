//! The decoder as a WebAssembly module with a plain C ABI.
//!
//! There's no wasm-bindgen: the module has no imports, and every export takes
//! and returns numbers, so it can be instantiated synchronously anywhere,
//! including inside an `AudioWorkletProcessor` (which has no `fetch`, and in
//! some browsers no `TextDecoder`). Strings and audio cross the boundary as
//! bytes in linear memory:
//!
//! - allocate with `cc_alloc(len)`, write, call, then `cc_free(ptr, len)`
//! - string results (JSON, or an error message) are read from
//!   `cc_result_ptr(h)` / `cc_result_len(h)` after the call that produced them
//! - calls that can fail return 0 on success and 1 on error, with the error
//!   (as JSON `{"path": ..., "message": ...}`) as the result
//!
//! Lifecycle (`h` is a handle from `cc_new`):
//!
//! ```text
//! cc_new(sample_rate) -> h
//! cc_load(h, json_ptr, json_len)            parse + validate; result: modules JSON
//! cc_resources(h)                           result: JSON array of URIs still needed
//! cc_provide(h, uri_ptr, uri_len, pcm_ptr, frames, sample_rate)   mono f32 PCM
//! cc_build(h, path_ptr, path_len)           path "" = whole document; result: layout JSON
//! cc_seek(h, seconds)                       skip ahead (absolute document time)
//! cc_render(h, out_ptr, frames) -> n        f32 frames of real audio; < frames at the end
//! cc_destroy(h)
//! ```

use std::alloc::{alloc, dealloc, Layout};

use cochlea_codec::{Audio, Decoder, Document, Error, Rendering};
use serde_json::json;

pub struct Handle {
    decoder: Decoder,
    document: Option<Document>,
    rendering: Option<Rendering>,
    result: Vec<u8>,
}

/// A decoder with every module this build knows: the core ones, plus gammatone
pub fn decoder(sample_rate: f64) -> Decoder {
    let mut d = Decoder::new(sample_rate);
    d.register(cochlea_codec_gammatone::Gammatone).expect("gammatone registers once");
    d
}

impl Handle {
    fn ok(&mut self, value: serde_json::Value) -> u32 {
        self.result = value.to_string().into_bytes();
        0
    }

    fn fail(&mut self, e: Error) -> u32 {
        self.result = json!({ "path": e.path, "message": e.message }).to_string().into_bytes();
        1
    }
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

unsafe fn string(ptr: *const u8, len: usize) -> Result<String, Error> {
    String::from_utf8(bytes(ptr, len).to_vec()).map_err(|_| Error::new("", "not UTF-8"))
}

#[no_mangle]
pub extern "C" fn cc_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::dangling().as_ptr();
    }
    unsafe { alloc(Layout::from_size_align_unchecked(len, 8)) }
}

/// # Safety
/// `ptr` and `len` must come from one `cc_alloc` call
#[no_mangle]
pub unsafe extern "C" fn cc_free(ptr: *mut u8, len: usize) {
    if len != 0 {
        dealloc(ptr, Layout::from_size_align_unchecked(len, 8));
    }
}

#[no_mangle]
pub extern "C" fn cc_new(sample_rate: f64) -> *mut Handle {
    Box::into_raw(Box::new(Handle { decoder: decoder(sample_rate), document: None, rendering: None, result: Vec::new() }))
}

/// # Safety
/// `h` must come from `cc_new` and not be used afterwards
#[no_mangle]
pub unsafe extern "C" fn cc_destroy(h: *mut Handle) {
    drop(Box::from_raw(h));
}

/// # Safety
/// `h` must come from `cc_new`
#[no_mangle]
pub unsafe extern "C" fn cc_result_ptr(h: *const Handle) -> *const u8 {
    (*h).result.as_ptr()
}

/// # Safety
/// `h` must come from `cc_new`
#[no_mangle]
pub unsafe extern "C" fn cc_result_len(h: *const Handle) -> usize {
    (*h).result.len()
}

/// Parses a document. The result is the decoder's modules.
///
/// # Safety
/// `h` must come from `cc_new`; `ptr`/`len` must be readable
#[no_mangle]
pub unsafe extern "C" fn cc_load(h: *mut Handle, ptr: *const u8, len: usize) -> u32 {
    let h = &mut *h;
    h.rendering = None;
    let parsed = string(ptr, len).and_then(|json| h.decoder.parse(&json));
    match parsed {
        Ok(doc) => {
            h.document = Some(doc);
            let modules = serde_json::to_value(h.decoder.modules()).unwrap_or_default();
            h.ok(json!({ "modules": modules }))
        }
        Err(e) => {
            h.document = None;
            h.fail(e)
        }
    }
}

/// The URIs the loaded document still needs
///
/// # Safety
/// `h` must come from `cc_new`
#[no_mangle]
pub unsafe extern "C" fn cc_resources(h: *mut Handle) -> u32 {
    let h = &mut *h;
    match &h.document {
        Some(doc) => {
            let missing = h.decoder.missing_resources(doc);
            h.ok(json!(missing))
        }
        None => h.fail(Error::new("", "no document loaded")),
    }
}

/// Supplies decoded mono audio for a URI
///
/// # Safety
/// `h` must come from `cc_new`; the pointers must be readable for their lengths
#[no_mangle]
pub unsafe extern "C" fn cc_provide(
    h: *mut Handle,
    uri_ptr: *const u8,
    uri_len: usize,
    pcm_ptr: *const f32,
    frames: usize,
    sample_rate: f64,
) -> u32 {
    let h = &mut *h;
    match string(uri_ptr, uri_len) {
        Ok(uri) => {
            let pcm = if frames == 0 { Vec::new() } else { std::slice::from_raw_parts(pcm_ptr, frames).to_vec() };
            h.decoder.provide(uri, Audio::new(sample_rate, pcm));
            h.ok(json!(null))
        }
        Err(e) => h.fail(e),
    }
}

/// Prepares the whole document (`path` empty) or one node (a JSON Pointer,
/// played in context) for rendering. The result describes where every node plays.
///
/// # Safety
/// `h` must come from `cc_new`; `path_ptr`/`path_len` must be readable
#[no_mangle]
pub unsafe extern "C" fn cc_build(h: *mut Handle, path_ptr: *const u8, path_len: usize) -> u32 {
    let h = &mut *h;
    let path = match string(path_ptr, path_len) {
        Ok(p) => p,
        Err(e) => return h.fail(e),
    };
    let Some(doc) = &h.document else {
        return h.fail(Error::new("", "no document loaded"));
    };
    match h.decoder.render_node(doc, if path.is_empty() { None } else { Some(&path) }) {
        Ok(rendering) => {
            let description = serde_json::to_value(rendering.describe()).unwrap_or_default();
            h.rendering = Some(rendering);
            h.ok(description)
        }
        Err(e) => h.fail(e),
    }
}

/// Skips ahead to an absolute time in the document (rendering is one-way)
///
/// # Safety
/// `h` must come from `cc_new`
#[no_mangle]
pub unsafe extern "C" fn cc_seek(h: *mut Handle, seconds: f64) {
    let h = &mut *h;
    if let Some(r) = &mut h.rendering {
        r.seek((seconds.max(0.0) * r.sample_rate).round() as u64);
    }
}

/// Renders the next `frames` frames into `out` (overwriting it). Returns the
/// number of real frames; fewer than `frames` means the end was reached.
///
/// # Safety
/// `h` must come from `cc_new`; `out` must be writable for `frames` f32s
#[no_mangle]
pub unsafe extern "C" fn cc_render(h: *mut Handle, out: *mut f32, frames: usize) -> usize {
    let h = &mut *h;
    let out = std::slice::from_raw_parts_mut(out, frames);
    match &mut h.rendering {
        Some(r) => r.render(out),
        None => {
            out.fill(0.0);
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(h: *mut Handle) -> serde_json::Value {
        unsafe { serde_json::from_slice(bytes(cc_result_ptr(h), cc_result_len(h))).unwrap() }
    }

    #[test]
    fn drives_the_whole_lifecycle_through_the_c_abi() {
        unsafe {
            let h = cc_new(1000.0);
            let doc = br#"{"format":"cochlea-codec","version":"0.2","root":{"type":"sequencer","events":[
                {"time_seconds":0,"node":{"type":"sampler","url":"x"}},
                {"time_seconds":0.01,"node":{"type":"org.cochlea.gammatone","center_frequency":100,"duration_seconds":0.005}}]}}"#;
            assert_eq!(cc_load(h, doc.as_ptr(), doc.len()), 0);
            assert_eq!(cc_resources(h), 0);
            assert_eq!(result(h), json!(["x"]));

            assert_eq!(cc_build(h, std::ptr::null(), 0), 1);
            assert!(result(h)["message"].as_str().unwrap().contains("not loaded"));

            let pcm = [1.0f32, 1.0];
            let uri = b"x";
            assert_eq!(cc_provide(h, uri.as_ptr(), 1, pcm.as_ptr(), 2, 1000.0), 0);
            assert_eq!(cc_build(h, std::ptr::null(), 0), 0);
            assert_eq!(result(h)["duration_seconds"], json!(0.015));

            let mut out = [9.0f32; 32];
            assert_eq!(cc_render(h, out.as_mut_ptr(), 32), 15);
            assert_eq!(&out[..3], &[1.0, 1.0, 0.0]);
            assert_eq!(out[20], 0.0);

            let bad = br#"{"format":"cochlea-codec","version":"0.2","root":{"type":"nope"}}"#;
            assert_eq!(cc_load(h, bad.as_ptr(), bad.len()), 1);
            assert_eq!(result(h)["path"], json!("/root"));
            cc_destroy(h);
        }
    }

    #[test]
    fn every_example_document_parses() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples");
        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "json") {
                let d = decoder(44100.0);
                let doc = d.parse(&std::fs::read_to_string(&path).unwrap());
                assert!(doc.is_ok(), "{}: {}", path.display(), doc.err().unwrap());
                // documents without remote resources render here, offline
                let doc = doc.unwrap();
                let mut d = d;
                d.provide_data_uris(&doc).unwrap();
                if d.missing_resources(&doc).is_empty() {
                    let audio = d.render(&doc).unwrap().render_all();
                    assert!(!audio.samples.is_empty(), "{}", path.display());
                }
                seen += 1;
            }
        }
        assert!(seen >= 2, "found {seen} examples in {}", dir.display());
    }
}
