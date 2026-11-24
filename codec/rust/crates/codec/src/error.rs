use std::fmt;

/// Everything that can go wrong decoding a document. `path` is a JSON Pointer
/// (RFC 6901) to the offending part of the document, e.g. `/root/events/3/node`,
/// so editors and viewers can point at it.
#[derive(Debug, Clone, PartialEq)]
pub struct Error {
    pub path: String,
    pub message: String,
}

impl Error {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Error { path: path.into(), message: message.into() }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() {
            write!(f, "{}", self.message)
        } else {
            write!(f, "{}: {}", self.path, self.message)
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
