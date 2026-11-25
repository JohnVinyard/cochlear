use serde_json::json;

use super::*;

const RATE: f64 = 100.0;

fn doc(root: Value) -> Value {
    json!({ "format": "cochlea-codec", "version": "0.2", "root": root })
}

fn click() -> Audio {
    Audio::new(RATE, vec![1.0, 0.5])
}

fn decoder() -> Decoder {
    let mut d = Decoder::new(RATE);
    d.provide("click", click());
    d
}

fn sampler(url: &str) -> Value {
    json!({ "type": "sampler", "url": url })
}

fn at(t: f64, node: Value) -> Value {
    json!({ "time_seconds": t, "node": node })
}

fn onsets(samples: &[f32]) -> Vec<usize> {
    samples.iter().enumerate().filter(|(_, &s)| s == 1.0).map(|(i, _)| i).collect()
}

#[test]
fn sequences_samples_in_time() {
    let d = decoder();
    let document = d
        .parse_value(&doc(json!({ "type": "sequencer", "events": [at(0.0, sampler("click")), at(0.5, sampler("click"))] })))
        .unwrap();
    let audio = d.render(&document).unwrap().render_all();
    assert_eq!(audio.samples.len(), 52);
    assert_eq!(onsets(&audio.samples), vec![0, 50]);
}

#[test]
fn speed_compounds_through_nested_sequencers() {
    let d = decoder();
    // outer at speed 2: the inner sequencer starts at 1s / 2 = 0.5s; the
    // inner one, at speed 0.5, plays its event at 1s / (2 * 0.5) = 1s after that
    let inner = json!({ "type": "sequencer", "speed": 0.5, "events": [at(0.0, sampler("click")), at(1.0, sampler("click"))] });
    let document = d
        .parse_value(&doc(json!({ "type": "sequencer", "speed": 2, "events": [at(1.0, inner)] })))
        .unwrap();
    let rendering = d.render(&document).unwrap();
    let starts: Vec<_> = rendering.layout.iter().map(|n| (n.path.as_str(), n.start_seconds)).collect();
    assert_eq!(
        starts,
        vec![
            ("/root", 0.0),
            ("/root/events/0/node", 0.5),
            ("/root/events/0/node/events/0/node", 0.5),
            ("/root/events/0/node/events/1/node", 1.5),
        ]
    );
    let mut rendering = rendering;
    assert_eq!(onsets(&rendering.render_all().samples), vec![50, 150]);
}

#[test]
fn renders_one_node_in_context() {
    let d = decoder();
    let document = d
        .parse_value(&doc(json!({ "type": "sequencer", "events": [at(0.0, sampler("click")), at(0.3, sampler("click"))] })))
        .unwrap();
    let mut solo = d.render_node(&document, Some("/root/events/1/node")).unwrap();
    assert_eq!(solo.describe().start_seconds, 0.3);
    assert_eq!(solo.render_all().samples, vec![1.0, 0.5]);
    assert!(d.render_node(&document, Some("/root/events/9/node")).is_err());
}

#[test]
fn errors_point_at_the_problem() {
    let d = decoder();
    let err = |v: Value| d.parse_value(&v).err().unwrap();

    let e = err(doc(json!({ "type": "sequencer", "events": [at(0.0, json!({ "type": "theremin" }))] })));
    assert_eq!(e.path, "/root/events/0/node");
    assert!(e.message.contains("unknown type \"theremin\"") && e.message.contains("sampler, sequencer"), "{e}");

    let e = err(doc(json!({ "type": "sampler", "url": "click", "gian": 2 })));
    assert_eq!(e.path, "/root");
    assert!(e.message.contains("unknown field `gian`"), "{e}");

    let e = err(doc(json!({ "type": "sequencer", "events": [{ "time_seconds": -1, "node": sampler("click") }] })));
    assert_eq!(e.path, "/root/events/0");

    assert_eq!(err(json!({ "format": "mp3", "version": "0.1", "root": {} })).path, "/format");
    assert_eq!(err(json!({ "format": "cochlea-codec", "version": "1.0", "root": {} })).path, "/version");
}

#[test]
fn label_and_meta_are_allowed_on_any_node() {
    let d = decoder();
    let document = d
        .parse_value(&doc(json!({ "type": "sampler", "url": "click", "label": "kick", "meta": { "by": "me" } })))
        .unwrap();
    assert_eq!(document.root.label.as_deref(), Some("kick"));
}

#[test]
fn lists_resources_once_and_requires_them() {
    let mut d = Decoder::new(RATE);
    let document = d
        .parse_value(&doc(json!({ "type": "sequencer", "events": [
            at(0.0, json!({ "type": "sampler", "url": "a", "convolve": { "url": "room", "mix": 0.5 } })),
            at(1.0, sampler("a")),
        ] })))
        .unwrap();
    assert_eq!(document.resources(), vec!["a", "room"]);
    assert!(d.render(&document).err().unwrap().message.contains("resources not loaded: a, room"));
    d.provide("a", click());
    assert_eq!(d.missing_resources(&document), vec!["room"]);
}

#[test]
fn sampler_slices_and_processes() {
    let mut d = Decoder::new(RATE);
    d.provide("ramp", Audio::new(RATE, (0..100).map(|i| i as f32 / 100.0).collect()));
    d.provide("ir", Audio::new(RATE, vec![1.0, 0.0, 0.0]));
    let render = |node: Value| d.render(&d.parse_value(&doc(node)).unwrap()).unwrap().render_all().samples;

    let slice = render(json!({ "type": "sampler", "url": "ramp", "start_seconds": 0.1, "duration_seconds": 0.05, "gain": 2 }));
    assert_eq!(slice.len(), 5);
    assert!((slice[0] - 0.2).abs() < 1e-6);

    // an impulse IR at full mix is the identity, plus its tail
    let wet = render(json!({ "type": "sampler", "url": "ramp", "duration_seconds": 0.05, "convolve": { "url": "ir", "mix": 1 } }));
    assert_eq!(wet.len(), 7);
    assert!((wet[4] - 0.04).abs() < 1e-6 && wet[6].abs() < 1e-6);

    let past_end = d.parse_value(&doc(json!({ "type": "sampler", "url": "ramp", "start_seconds": 5 }))).unwrap();
    assert!(d.render(&past_end).err().unwrap().message.contains("past the end"));
}

#[test]
fn decodes_data_uris_natively() {
    let wav = audio::encode_wav_pcm16(&Audio::new(RATE, vec![0.5; 4]));
    let b64 = {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for chunk in wav.chunks(3) {
            let n = chunk.iter().enumerate().fold(0u32, |acc, (i, &b)| acc | (b as u32) << (16 - 8 * i));
            for i in 0..4 {
                s.push(if i <= chunk.len() { T[(n >> (18 - 6 * i)) as usize & 63] as char } else { '=' });
            }
        }
        s
    };
    let uri = format!("data:audio/wav;base64,{b64}");
    let mut d = Decoder::new(RATE);
    let document = d.parse_value(&doc(sampler(&uri))).unwrap();
    d.provide_data_uris(&document).unwrap();
    let samples = d.render(&document).unwrap().render_all().samples;
    assert_eq!(samples.len(), 4);
    assert!((samples[0] - 0.5).abs() < 1e-3);
}

#[test]
fn seeking_matches_rendering_from_the_start() {
    let d = decoder();
    let events: Vec<_> = (0..20).map(|i| at(i as f64 * 0.07, sampler("click"))).collect();
    let document = d.parse_value(&doc(json!({ "type": "sequencer", "events": events }))).unwrap();
    let full = d.render(&document).unwrap().render_all().samples;
    let mut r = d.render(&document).unwrap();
    r.seek(37);
    assert_eq!(r.render_all().samples, full[37..].to_vec());
}

#[test]
fn renders_in_small_blocks_like_an_audio_worklet() {
    let d = decoder();
    let events: Vec<_> = (0..20).map(|i| at(i as f64 * 0.013, sampler("click"))).collect();
    let document = d.parse_value(&doc(json!({ "type": "sequencer", "events": events }))).unwrap();
    let full = d.render(&document).unwrap().render_all().samples;
    let mut r = d.render(&document).unwrap();
    let mut blocks = Vec::new();
    let mut block = [0.0f32; 7];
    loop {
        let n = r.render(&mut block);
        blocks.extend_from_slice(&block[..n]);
        if n < block.len() {
            break;
        }
    }
    assert_eq!(blocks, full);
}

#[test]
fn modules_can_be_registered_once() {
    let mut d = Decoder::new(RATE);
    assert!(d.register(modules::Sampler).is_err());
    let names: Vec<_> = d.modules().into_iter().map(|m| m.type_name).collect();
    assert_eq!(names, vec!["sampler", "sequencer"]);
}

fn with_defs(defs: Value, root: Value) -> Value {
    json!({ "format": "cochlea-codec", "version": "0.2", "defs": defs, "root": root })
}

fn reference(name: &str) -> Value {
    json!({ "$ref": format!("#/defs/{name}") })
}

#[test]
fn a_pattern_can_be_defined_once_and_referenced() {
    let d = decoder();
    // the kick sound, and four of them on the beat, defined once...
    let defs = json!({
        "kick-sound": "click",
        "kick": { "type": "sampler", "label": "kick", "url": reference("kick-sound") },
        "four-kicks": { "type": "sequencer", "events": [
            at(0.0, reference("kick")), at(0.25, reference("kick")), at(0.5, reference("kick")), at(0.75, reference("kick"))
        ] },
    });
    // ...and played in two bars, the second relabelled
    let root = json!({ "type": "sequencer", "events": [
        at(0.0, reference("four-kicks")),
        at(1.0, json!({ "$ref": "#/defs/four-kicks", "label": "bar 2" })),
    ] });
    let document = d.parse_value(&with_defs(defs, root)).unwrap();
    assert_eq!(document.resources(), vec!["click"]);
    let mut rendering = d.render(&document).unwrap();
    let bar2 = rendering.layout.iter().find(|n| n.path == "/root/events/1/node").unwrap();
    assert_eq!(bar2.label.as_deref(), Some("bar 2"));
    assert_eq!(bar2.source, "/defs/four-kicks");
    assert_eq!(bar2.reference.as_deref(), Some("#/defs/four-kicks"));
    let kick = rendering.layout.iter().find(|n| n.path == "/root/events/1/node/events/2/node").unwrap();
    assert_eq!((kick.source.as_str(), kick.start_seconds), ("/defs/kick", 1.5));
    assert_eq!(onsets(&rendering.render_all().samples), vec![0, 25, 50, 75, 100, 125, 150, 175]);

    // one instance can be played on its own, in context
    let solo = d.render_node(&document, Some("/root/events/1/node")).unwrap();
    assert_eq!(solo.describe().start_seconds, 1.0);
}

#[test]
fn references_can_chain_and_any_value_can_be_one() {
    let d = decoder();
    let defs = json!({
        "decay": { "type": "linear", "points": [{ "time_seconds": 0, "gain": 1 }, { "time_seconds": 0.01, "gain": 0 }] },
        "plain": { "type": "sampler", "url": "click", "envelope": reference("decay") },
        "alias": reference("plain"),
    });
    let document = d.parse_value(&with_defs(defs, reference("alias"))).unwrap();
    assert_eq!(document.root.source, "/defs/plain");
    assert_eq!(document.root.reference.as_deref(), Some("#/defs/alias"));
    assert_eq!(d.render(&document).unwrap().render_all().samples, vec![1.0, 0.0]);
}

#[test]
fn bad_references_are_errors() {
    let d = decoder();
    let err = |defs: Value, root: Value| d.parse_value(&with_defs(defs, root)).err().unwrap();

    let e = err(json!({}), reference("nope"));
    assert_eq!((e.path.as_str(), e.message.as_str()), ("/root/$ref", "#/defs/nope doesn't exist"));

    let e = err(json!({ "a": reference("b"), "b": { "type": "sequencer", "events": [at(0.0, reference("a"))] } }), reference("a"));
    assert!(e.message.contains("refers to itself"), "{e}");

    let e = err(json!({}), json!({ "$ref": "#/root" }));
    assert!(e.message.contains("must point into this document's defs"), "{e}");

    let e = err(json!({ "k": sampler("click") }), json!({ "$ref": "#/defs/k", "gain": 2 }));
    assert_eq!(e.path, "/root/gain");

    // a mistake inside a definition is reported there, where it can be fixed
    let defs = json!({ "k": { "type": "sampler", "url": "click", "gian": 1 } });
    let e = err(defs, json!({ "type": "sequencer", "events": [at(0.0, sampler("click")), at(1.0, reference("k"))] }));
    assert_eq!(e.path, "/defs/k");
    assert!(e.message.contains("gian") && e.message.contains("/root/events/1/node"), "{e}");

    // exponential expansion is cut off
    let mut defs = serde_json::Map::new();
    defs.insert("p0".into(), sampler("click"));
    for i in 1..30 {
        let events: Vec<_> = (0..4).map(|_| at(0.0, reference(&format!("p{}", i - 1)))).collect();
        defs.insert(format!("p{i}"), json!({ "type": "sequencer", "events": events }));
    }
    assert!(err(Value::Object(defs), reference("p29")).message.contains("expands to more than"));
}

#[test]
fn meta_is_never_expanded() {
    let d = decoder();
    let root = json!({ "type": "sampler", "url": "click", "meta": { "schema": { "$ref": "#/elsewhere" } } });
    assert!(d.parse_value(&with_defs(json!({}), root)).is_ok());
}

struct Named(&'static str, &'static str);

impl Module for Named {
    fn type_name(&self) -> &'static str {
        self.0
    }
    fn version(&self) -> &'static str {
        self.1
    }
    fn parse(&self, node: &NodeRef, _: &ParseContext) -> Result<Box<dyn Node>> {
        Err(node.error("not for parsing"))
    }
}

#[test]
fn extension_types_are_reverse_dns_names() {
    let mut d = Decoder::new(RATE);
    for bad in ["theremin", "example.theremin", "org.Example.theremin", "org..theremin"] {
        assert!(d.register(Named(bad, "0.1")).is_err(), "{bad}");
    }
    assert!(d.register(Named("org.example.theremin", "1")).is_err(), "versions are major.minor");
    assert!(d.register(Named("org.example.theremin", "1.2")).is_ok());
}

#[test]
fn documents_can_declare_what_they_require() {
    let mut d = decoder();
    d.register(Named("org.example.theremin", "1.2")).unwrap();
    let requiring = |requires: Value| {
        d.parse_value(&json!({ "format": "cochlea-codec", "version": "0.2", "requires": requires, "root": sampler("click") }))
    };
    assert!(requiring(json!({ "org.example.theremin": "1.1", "sampler": "0.1" })).is_ok());
    let e = requiring(json!({ "org.example.theremin": "1.3" })).err().unwrap();
    assert_eq!(e.path, "/requires/org.example.theremin");
    assert!(e.message.contains("has 1.2"), "{e}");
    assert!(requiring(json!({ "org.example.theremin": "2.0" })).is_err());
    assert!(requiring(json!({ "org.example.cello": "0.1" })).err().unwrap().message.contains("no module"));
}

#[test]
fn versions_compare_as_numbers() {
    let d = decoder();
    let version = |v: &str| d.parse_value(&json!({ "format": "cochlea-codec", "version": v, "root": sampler("click") }));
    assert!(version("0.1").is_ok());
    assert!(version("0.2").is_ok());
    assert!(version("0.10").is_err());
    assert!(version("1.0").is_err());
}

// -- parts of resources -------------------------------------------------------

#[test]
fn asks_for_only_the_parts_of_resources_samplers_play() {
    let d = Decoder::new(RATE);
    let document = d
        .parse_value(&doc(json!({ "type": "sequencer", "events": [
            at(0.0, json!({ "type": "sampler", "url": "long", "start_seconds": 10, "duration_seconds": 1 })),
            // overlaps the first: merged
            at(1.0, json!({ "type": "sampler", "url": "long", "start_seconds": 10.5, "duration_seconds": 1 })),
            at(2.0, json!({ "type": "sampler", "url": "long", "start_seconds": 100, "duration_seconds": 0.5 })),
            // no duration: to the end; an impulse response: all of it
            at(3.0, json!({ "type": "sampler", "url": "other", "start_seconds": 2,
                            "convolve": { "url": "room", "mix": 0.5 } })),
        ] })))
        .unwrap();
    assert_eq!(
        d.resource_requests(&document),
        vec![
            ResourceRequest { uri: "long".into(), spans: vec![Span::new(10.0, Some(11.5)), Span::new(100.0, Some(100.5))] },
            ResourceRequest { uri: "other".into(), spans: vec![Span::new(2.0, None)] },
            ResourceRequest { uri: "room".into(), spans: vec![Span::WHOLE] },
        ]
    );
}

#[test]
fn renders_from_parts_of_resources() {
    let mut d = Decoder::new(RATE);
    let document = d
        .parse_value(&doc(json!({ "type": "sequencer", "events": [
            at(0.0, json!({ "type": "sampler", "url": "long", "start_seconds": 10, "duration_seconds": 0.2 })),
        ] })))
        .unwrap();
    // RATE is 100: 20 frames, from frame 1000 of an hour-long sound
    let ramp: Vec<f32> = (0..20).map(|i| i as f32).collect();
    d.provide_span("long", 10.0, Audio::new(RATE, ramp.clone()), Some(3600.0));
    assert!(d.resource_requests(&document).is_empty());
    assert_eq!(d.render(&document).unwrap().render_all().samples, ramp);

    // a part elsewhere doesn't help
    let mut d = Decoder::new(RATE);
    d.provide_span("long", 20.0, Audio::new(RATE, ramp.clone()), Some(3600.0));
    assert_eq!(d.missing_resources(&document), vec!["long"]);
    assert!(d.render(&document).err().unwrap().message.contains("resources not loaded: long"));
}

#[test]
fn clamps_parts_to_the_resource_length() {
    let mut d = Decoder::new(RATE);
    let render = |d: &Decoder, node: Value| d.render(&d.parse_value(&doc(node)).unwrap()).map(|mut r| r.render_all().samples);
    // the sound is 1.1 s long; the sampler asks for a second from 1.0
    d.provide_span("short", 1.0, Audio::new(RATE, vec![1.0; 10]), Some(1.1));
    let node = json!({ "type": "sampler", "url": "short", "start_seconds": 1.0, "duration_seconds": 1.0 });
    assert!(d.resource_requests(&d.parse_value(&doc(node.clone())).unwrap()).is_empty());
    assert_eq!(render(&d, node).unwrap().len(), 10);
    // and starting past the end is still an error, given the length
    let past = json!({ "type": "sampler", "url": "short", "start_seconds": 2.0, "duration_seconds": 0.1 });
    assert!(render(&d, past).err().unwrap().message.contains("past the end"));
}

#[test]
fn resamples_parts_at_their_offsets() {
    let mut d = Decoder::new(RATE);
    // half the output rate, a second of it, starting 5 s in: frame 500 at the output rate
    d.provide_span("x", 5.0, Audio::new(RATE / 2.0, vec![1.0; 50]), None);
    let document =
        d.parse_value(&doc(json!({ "type": "sampler", "url": "x", "start_seconds": 5.5, "duration_seconds": 0.4 }))).unwrap();
    assert!(d.resource_requests(&document).is_empty());
    let samples = d.render(&document).unwrap().render_all().samples;
    assert_eq!(samples.len(), 40);
    assert!(samples.iter().all(|s| *s == 1.0));
}

#[test]
fn needs_all_of_an_impulse_response() {
    let mut d = Decoder::new(RATE);
    d.provide("a", click());
    d.provide_span("room", 0.0, Audio::new(RATE, vec![1.0; 3]), None);
    let document = d
        .parse_value(&doc(json!({ "type": "sampler", "url": "a", "convolve": { "url": "room", "mix": 0.5 } })))
        .unwrap();
    // its length isn't known, so a part that starts at 0 might not be all of it
    assert_eq!(d.missing_resources(&document), vec!["room"]);
    d.provide("room", Audio::new(RATE, vec![1.0; 3]));
    assert!(d.render(&document).is_ok());
}

#[test]
fn merges_spans() {
    let s = |a: f64, b: Option<f64>| Span::new(a, b);
    assert_eq!(merge_spans(vec![s(5.0, Some(6.0)), s(0.0, Some(1.0)), s(1.0, Some(2.0))]), vec![s(0.0, Some(2.0)), s(5.0, Some(6.0))]);
    assert_eq!(merge_spans(vec![s(3.0, None), s(4.0, Some(9.0)), s(0.0, Some(1.0))]), vec![s(0.0, Some(1.0)), s(3.0, None)]);
}
