//! Canonical `product.lock` serialization, hashing, and structural diff.
//!
//! [`write_canonical`] is the only writer: it sorts every collection on a
//! [`gearbox_ir::ResolvedProduct`] into the order its own doc comments
//! promise, hashes the result, and renders it as TOML with a two-line
//! generated header. [`read`] is the only reader, and it verifies that hash
//! on the way in -- a `product.lock` that was hand-edited fails to read
//! rather than silently taking effect. [`diff`] compares two resolved
//! products structurally, for a lock diff that is minimal rather than a
//! reformatted-everything text diff.

mod canonical;
mod diff;
mod error;
mod read;

pub use canonical::{canonicalize_order, write_canonical};
pub use diff::{BindingKey, ClusterKey, LockDiff, diff};
pub use error::LockError;
pub use read::read;
