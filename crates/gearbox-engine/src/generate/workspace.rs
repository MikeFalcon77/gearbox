//! The generated workspace root, its toolchain pin, and the lock beside them.

use gearbox_ir::{FileEntry, FileKind, Ownership, ResolvedProcess, ResolvedProduct};
use serde::Serialize;

use super::{GenerateError, header, paths};

/// The toolchain the generated crates build with.
///
/// Copied from `gears-rust/rust-toolchain.toml` rather than from this
/// repository's: the generated crates path-depend on `gears-rust` sources, so
/// the toolchain that has to accept them is the platform's, not ours. The two
/// happen to agree today, and pinning to the wrong one of the two would be
/// invisible until the day they stop agreeing.
const CHANNEL: &str = "1.97.0";

/// The rustc channel the generated crates -- and therefore their
/// Dockerfiles -- pin. One function so a Dockerfile cannot drift from
/// `rust-toolchain.toml` by restating the literal.
pub const fn rust_channel() -> &'static str {
    CHANNEL
}

/// The Rust edition written into every generated manifest.
///
/// Written out as a literal, and this is the single most consequential literal
/// in the generator. The gear crates the output depends on say
/// `edition.workspace = true`, which resolves for *them* because they physically
/// live inside the `gears-rust` workspace. The generated crates live under
/// `.gearbox/<product>/<profile>/`, outside every workspace but their own, so
/// inheriting anything is not available to them: the field must carry a value.
const EDITION: &str = "2024";

/// Matches `gears-rust`'s `workspace.package.rust-version`.
///
/// Deliberately the platform's floor and not this repository's `1.97.0`: the
/// generated crate's minimum is dictated by what it links against.
const RUST_VERSION: &str = "1.95.0";

#[derive(Serialize)]
struct WorkspaceManifest {
    workspace: WorkspaceTable,
}

#[derive(Serialize)]
struct WorkspaceTable {
    resolver: &'static str,
    members: Vec<String>,
}

/// The generated workspace root.
///
/// A `[workspace]` table is not optional here, and not for tidiness: the output
/// root sits inside this repository, so without one Cargo would walk up, find
/// `gearbox-builder`'s root manifest, and refuse the package as "believes it's
/// in a workspace when it's not". Declaring the workspace is what stops that
/// walk.
///
/// # Errors
/// Returns [`GenerateError`] if the manifest cannot be serialized.
pub fn workspace_manifest(processes: &[&ResolvedProcess]) -> Result<FileEntry, GenerateError> {
    let manifest = WorkspaceManifest {
        workspace: WorkspaceTable {
            resolver: "3",
            members: processes
                .iter()
                .map(|p| format!("processes/{}", p.name))
                .collect(),
        },
    };
    let body = toml::to_string_pretty(&manifest).map_err(|source| GenerateError::Toml {
        what: "the generated workspace manifest",
        source,
    })?;

    Ok(FileEntry::text(
        paths::rel(&["Cargo.toml"])?,
        format!("{}\n{body}", header("#")),
        FileKind::Toml,
        Ownership::Generated,
    ))
}

/// The toolchain pin.
///
/// Written by hand rather than through serde: the file has three lines, and a
/// `#[derive(Serialize)]` for them would be longer than the file.
///
/// # Errors
/// Returns [`GenerateError`] only if the fixed path fails validation, which it
/// cannot.
pub fn toolchain() -> Result<FileEntry, GenerateError> {
    let body = format!(
        "{}\n[toolchain]\nchannel = \"{CHANNEL}\"\ncomponents = [\"rustfmt\", \"clippy\"]\n",
        header("#")
    );
    Ok(FileEntry::text(
        paths::rel(&["rust-toolchain.toml"])?,
        body,
        FileKind::Toml,
        Ownership::Generated,
    ))
}

/// The resolved product, beside the tree it produced.
///
/// Writing the lock into the output root rather than next to `product.gdl` is
/// what makes `gearbox lock gears` answerable from inside a generated tree, and
/// it keeps the answer profile-specific: three profiles produce three different
/// topologies from one description, so one lock next to the description could
/// only ever describe one of them.
///
/// # Errors
/// Returns [`GenerateError::Lock`] if the lock cannot be serialized.
pub fn lock_file(product: &ResolvedProduct) -> Result<FileEntry, GenerateError> {
    Ok(FileEntry::text(
        paths::rel(&["product.lock"])?,
        gearbox_lock::write_canonical(product)?,
        FileKind::Toml,
        // `Generated`, and marked read-only in the editor per ADR
        // `cpt-gearbox-adr-authoring-ownership-tiers`: `gearbox_lock::read`
        // verifies the hash on the way in, so a hand-edited lock fails to load
        // rather than quietly taking effect.
        Ownership::Generated,
    ))
}

/// The edition, rust-version and resolver a generated package declares.
///
/// Exposed so the process manifest writes the same literals the workspace does,
/// which is the point of them being constants rather than string literals at
/// two call sites.
pub const fn package_edition() -> &'static str {
    EDITION
}

pub const fn package_rust_version() -> &'static str {
    RUST_VERSION
}
