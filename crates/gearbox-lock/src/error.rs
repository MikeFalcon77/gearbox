//! Errors from serializing, parsing, or verifying a `product.lock`.

/// Something went wrong reading or writing a lock.
#[derive(Debug, thiserror::Error)]
pub enum LockError {
    /// The lock declares a schema version this build does not understand.
    ///
    /// A reader that guessed at an unknown version would silently misread a
    /// future format; refusing is the safe failure.
    #[error(
        "product.lock schema_version {found} is not supported by this build \
         (supports {supported}); regenerate it with a matching gearbox version"
    )]
    UnsupportedSchemaVersion { found: u32, supported: u32 },

    /// The product could not be serialized to TOML.
    #[error("failed to serialize product.lock: {0}")]
    Serialize(#[from] toml::ser::Error),

    /// The lock text could not be parsed as TOML, or did not match the
    /// resolved-product schema.
    #[error("failed to parse product.lock: {0}")]
    Parse(#[from] toml::de::Error),

    /// The lock's recorded hash does not match its own content.
    ///
    /// This is what catches a hand-edited lock: the file claims to be exactly
    /// what `gearbox resolve` would have written, and it is not.
    #[error(
        "product.lock has been modified: it claims hash {expected}, but its \
         content hashes to {found}. Run `gearbox resolve` to regenerate it \
         rather than editing it by hand."
    )]
    HashMismatch { expected: String, found: String },
}
