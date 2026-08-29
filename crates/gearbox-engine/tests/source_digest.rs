//! The lock records what was read, not who asked.
//!
//! `ResolvedSource.digest` was `path:<declared location>` -- the caller's own
//! spelling of the root. That put the spelling into `lock_hash`, so the same
//! product and profile serialised to two different locks depending on the client:
//! the CLI run from the repository declared `../gears-rust`, while Studio's
//! backend declared an absolute path. Observed as two files on disk with
//! different hashes.
//!
//! A hash whose whole job is to answer "did anything change"
//! (`cpt-gearbox-nfr-determinism`) cannot depend on how the question was phrased,
//! and a lock carrying an absolute path is not portable to another machine. These
//! tests hold both halves.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_engine::{DIGEST_UNREAD, SourceRoot, content_digest, load_catalogue, lock_sources};
use gearbox_ir::{Catalogue, SourceId};

/// A throwaway tree with `n` descriptions in it.
///
/// Written rather than borrowed from the corpus, because these tests need to
/// *edit* a description and watch the digest move, and the corpus is not theirs
/// to modify.
fn tree(marker: &str, gears: &[(&str, &str)]) -> PathBuf {
    let root = std::env::temp_dir().join(format!("gearbox-digest-{marker}-{}", std::process::id()));
    std::fs::remove_dir_all(&root).ok();
    for (name, body) in gears {
        let dir = root.join("gears").join(name);
        std::fs::create_dir_all(&dir).expect("create the gear directory");
        std::fs::write(dir.join("gear.gdl"), body).expect("write the description");
    }
    root
}

fn open(root: &Path) -> SourceRoot {
    SourceRoot::open(SourceId::new("gears").expect("a valid id"), root).expect("open the root")
}

fn digest_of(catalogue: &Catalogue, id: &str) -> String {
    catalogue
        .sources
        .get(&SourceId::new(id).expect("a valid id"))
        .map(|source| source.digest.clone())
        .unwrap_or_default()
}

const GEAR_A: &str = r#"gear(name = "alpha", category = "system")"#;
const GEAR_B: &str = r#"gear(name = "beta", category = "system")"#;

#[test]
fn the_digest_is_the_same_however_the_root_was_spelled() {
    // The claim in one test. Two `SourceRoot`s over the same directory, one
    // declared absolute and one declared through a `..` detour, must agree --
    // because the digest is over content, and the content is identical.
    let root = tree("spelling", &[("alpha", GEAR_A), ("beta", GEAR_B)]);
    let absolute = root.canonicalize().expect("canonicalize");
    let detour = absolute.join("gears").join("..");

    let direct = load_catalogue(&[open(&absolute)]).catalogue;
    let indirect = load_catalogue(&[open(&detour)]).catalogue;

    let a = digest_of(&direct, "gears");
    let b = digest_of(&indirect, "gears");
    assert!(a.starts_with("blake3:"), "a content digest, not `{a}`");
    assert_eq!(
        a, b,
        "the same tree spelled two ways produced two digests, which is the defect \
         this test exists for"
    );

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn editing_a_description_moves_the_digest() {
    // The other half: client-independence is worthless if the digest is also
    // content-blind. A digest over the *paths* alone would pass the test above and
    // fail this one, which is why both are here.
    let root = tree("edit", &[("alpha", GEAR_A)]);
    let before = digest_of(&load_catalogue(&[open(&root)]).catalogue, "gears");

    std::fs::write(
        root.join("gears/alpha/gear.gdl"),
        r#"gear(name = "alpha", category = "domain")"#,
    )
    .expect("rewrite the description");
    let after = digest_of(&load_catalogue(&[open(&root)]).catalogue, "gears");

    assert_ne!(before, after, "an edited description did not move the digest");

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn a_description_that_moves_is_a_change() {
    // Paths are hashed as well as bytes. Renaming a gear's directory leaves every
    // byte in the tree identical, and it is still a different tree: the catalogue
    // keys gears by `gdl_path`, and a generated crate names its source file.
    let root = tree("moved", &[("alpha", GEAR_A)]);
    let before = digest_of(&load_catalogue(&[open(&root)]).catalogue, "gears");

    std::fs::rename(root.join("gears/alpha"), root.join("gears/renamed")).expect("rename");
    let after = digest_of(&load_catalogue(&[open(&root)]).catalogue, "gears");

    assert_ne!(before, after, "a moved description did not move the digest");

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn the_order_files_are_offered_in_does_not_matter() {
    // Discovery is sorted, but `content_digest` sorts again rather than trusting
    // its caller: it is public, and a digest that depends on argument order would
    // be a trap for the next caller rather than a bug in this one.
    let root = tree("order", &[("alpha", GEAR_A), ("beta", GEAR_B)]);
    let absolute = root.canonicalize().expect("canonicalize");
    let a = absolute.join("gears/alpha/gear.gdl");
    let b = absolute.join("gears/beta/gear.gdl");

    assert_eq!(
        content_digest(&absolute, &[a.clone(), b.clone()]),
        content_digest(&absolute, &[b, a]),
    );

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn a_root_nothing_scanned_says_so() {
    // `to_resolved` is called before discovery, so it cannot claim a digest. The
    // marker is visible in a lock rather than being a plausible-looking hash of
    // nothing.
    let root = tree("unread", &[("alpha", GEAR_A)]);
    assert_eq!(open(&root).to_resolved().digest, DIGEST_UNREAD);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn a_lock_records_the_root_relative_to_the_description() {
    // The second half of client-independence. An absolute path in a lock is not
    // portable, and a path relative to the working directory depends on where the
    // command was run; relative to the description means the same thing anywhere,
    // which is the form `gearbox-lock`'s own fixture already hand-writes.
    let root = tree("relative", &[("alpha", GEAR_A)]);
    let absolute = root.canonicalize().expect("canonicalize");
    let opened = vec![open(&absolute)];
    let catalogue = load_catalogue(&opened).catalogue;

    // A description one directory below the root's parent, so the answer needs a
    // `..` and cannot be right by accident.
    let products = absolute.join("products");
    std::fs::create_dir_all(&products).expect("create products");
    let description = products.join("product.gdl");
    std::fs::write(&description, "product()").expect("write the description");

    let sources: BTreeMap<_, _> = lock_sources(&opened, &catalogue, &description);
    let recorded = sources
        .get(&SourceId::new("gears").expect("a valid id"))
        .expect("the root is in the lock");

    assert_eq!(recorded.location, "..", "expected a relative location");
    assert!(
        recorded.digest.starts_with("blake3:"),
        "the lock took the catalogue's digest, not `{}`",
        recorded.digest
    );

    std::fs::remove_dir_all(&root).ok();
}
