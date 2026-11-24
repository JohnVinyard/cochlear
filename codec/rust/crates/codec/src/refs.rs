//! References: `{"$ref": "#/defs/name"}` stands in for any value inside
//! `root` or `defs` (except inside `meta`), so a sound, an envelope or a
//! whole pattern can be defined once and used many times.
//!
//! The decoder expands references *before* parsing, so modules never see
//! them. Each node keeps its **instance path** (where it is in the expanded
//! tree, e.g. `/root/events/2/node`), which is unique and is what layouts,
//! errors and solo playback use, and also gets a **source** pointer: where
//! its JSON actually is in the document (e.g. `/defs/four-kicks`).

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// The only keys allowed next to `$ref`. They override the target's.
const REF_SIBLINGS: [&str; 2] = ["label", "meta"];

/// Guards against documents whose references expand exponentially
/// (a "billion laughs" of nested patterns)
const MAX_EXPANDED_VALUES: usize = 4_000_000;

/// Where each referenced subtree came from: instance path -> (pointer to the
/// referenced JSON, the `$ref` as written)
#[derive(Default)]
pub(crate) struct Sources(HashMap<String, (String, String)>);

impl Sources {
    /// Where the JSON for an instance path is in the document
    pub fn source(&self, path: &str) -> String {
        let mut prefix = path;
        loop {
            if let Some((target, _)) = self.0.get(prefix) {
                return format!("{target}{}", &path[prefix.len()..]);
            }
            match prefix.rfind('/') {
                Some(i) if i > 0 => prefix = &prefix[..i],
                _ => return path.to_string(),
            }
        }
    }

    /// The `$ref` written at exactly this instance path, if there is one
    pub fn reference(&self, path: &str) -> Option<String> {
        self.0.get(path).map(|(_, r)| r.clone())
    }

    /// Re-points an error at the JSON that caused it, which is the thing to fix
    pub fn locate(&self, e: Error) -> Error {
        if e.path.is_empty() {
            return e;
        }
        let source = self.source(&e.path);
        if source == e.path {
            e
        } else {
            Error::new(source, format!("{} (where it's used, at {})", e.message, e.path))
        }
    }
}

pub(crate) fn escape_token(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

struct Expander<'a> {
    document: &'a Value,
    sources: Sources,
    count: usize,
    /// Definitions being expanded, to catch cycles
    stack: Vec<String>,
}

/// Expands every reference in `value` (found at `path` in `document`)
pub(crate) fn expand(document: &Value, value: &Value, path: &str) -> Result<(Value, Sources)> {
    let mut x = Expander { document, sources: Sources::default(), count: 0, stack: Vec::new() };
    match x.expand(value, path) {
        Ok(v) => Ok((v, x.sources)),
        Err(e) => Err(x.sources.locate(e)),
    }
}

impl Expander<'_> {
    fn expand(&mut self, value: &Value, path: &str) -> Result<Value> {
        self.count += 1;
        if self.count > MAX_EXPANDED_VALUES {
            return Err(Error::new(
                path,
                format!("the document expands to more than {MAX_EXPANDED_VALUES} values; are its references nested too deeply?"),
            ));
        }
        match value {
            Value::Object(object) if object.contains_key("$ref") => self.reference(object, path),
            Value::Object(object) => {
                let mut out = Map::with_capacity(object.len());
                for (k, v) in object {
                    // meta is opaque: it may hold "$ref"s that mean something else
                    let v = if k == "meta" { v.clone() } else { self.expand(v, &format!("{path}/{}", escape_token(k)))? };
                    out.insert(k.clone(), v);
                }
                Ok(Value::Object(out))
            }
            Value::Array(items) => items
                .iter()
                .enumerate()
                .map(|(i, v)| self.expand(v, &format!("{path}/{i}")))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array),
            other => Ok(other.clone()),
        }
    }

    fn reference(&mut self, object: &Map<String, Value>, path: &str) -> Result<Value> {
        let at = |m: &str| Error::new(format!("{path}/$ref"), m.to_string());
        let reference = object["$ref"].as_str().ok_or_else(|| at("must be a string, e.g. \"#/defs/kick\""))?;
        if let Some(k) = object.keys().find(|k| *k != "$ref" && !REF_SIBLINGS.contains(&k.as_str())) {
            return Err(Error::new(
                format!("{path}/{}", escape_token(k)),
                "only label and meta may sit next to a $ref",
            ));
        }
        let target = reference
            .strip_prefix('#')
            .filter(|p| p.starts_with("/defs/"))
            .ok_or_else(|| at("references must point into this document's defs, e.g. \"#/defs/kick\""))?
            .to_string();
        let resolved = self
            .document
            .pointer(&target)
            .ok_or_else(|| at(&format!("{reference} doesn't exist")))?;
        if self.stack.contains(&target) {
            return Err(at(&format!("{reference} refers to itself, via {}", self.stack.join(" -> "))));
        }
        // a reference to a reference records the final target as the source
        self.sources.0.insert(path.to_string(), (target.clone(), reference.to_string()));
        self.stack.push(target);
        let mut out = self.expand(resolved, path)?;
        self.stack.pop();
        if let Some((_, r)) = self.sources.0.get_mut(path) {
            *r = reference.to_string(); // keep the reference as written here, not the inner one
        }
        for key in REF_SIBLINGS {
            if let Some(v) = object.get(key) {
                let Value::Object(target) = &mut out else {
                    return Err(Error::new(format!("{path}/{key}"), "label and meta can only override an object"));
                };
                target.insert(key.to_string(), v.clone());
            }
        }
        Ok(out)
    }
}
