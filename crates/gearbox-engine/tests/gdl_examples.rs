//! The worked examples in the GDL reference are executed, not just printed.
//!
//! **The reference moved to `gears-rust/docs/gdl.md`**, beside the gears it
//! describes and the people who write them. The document went; this check
//! followed it, because a reference whose examples nobody runs is how the two
//! below rotted in the first place. The cost is that a checkout without the
//! corpus can no longer run them, which is the same gate the product example
//! already had.
//!
//! They had rotted, and the way they rotted is the argument for this file. The
//! product example declared `provider("postgres", …)` with no `secret_ref` --
//! which the same document calls `GBX0506` one page earlier -- and left
//! `use_gear("cluster", …)` out of a product declaring cluster profiles, which
//! makes every cluster requirement `GBX0505`. Anyone who copied it got errors
//! from the reference that was supposed to teach them the language.
//!
//! Nothing had ever run them. A language reference is the one document whose
//! examples can be checked mechanically, so leaving them unchecked was a choice
//! nobody made deliberately.
//!
//! **Extracted, not copied.** The examples are read out of `docs/gdl.md` at test
//! time. A copy pasted into this file would pass forever while the document
//! drifted, which is the failure being fixed rather than a different one.
//!
//! The two examples can claim different things and are checked differently. The
//! gear example names a crate that does not exist on disk, so it is *evaluated*
//! -- syntax, refused arguments, records -- and no more. The product example is
//! evaluated and then **resolved against the real corpus**, which is what makes
//! `GBX0505` and `GBX0506` observable at all.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};

use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_gdl::GdlEngine;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::{Diagnostic, RelPath, Severity, SourceId};

/// The reference, in the corpus checkout that now holds it.
///
/// `None` when there is no checkout -- the same condition the product example
/// already skipped on, now reaching the document itself.
fn gdl_md() -> Option<PathBuf> {
    corpus()?.join("docs/gdl.md").canonicalize().ok()
}

/// Whether this run demanded the corpus rather than merely preferring it.
fn required() -> bool {
    std::env::var("GEARBOX_CORPUS_REQUIRED").is_ok()
}

/// What to do about the reference.
///
/// Separated from *finding* it so the decision can be tested. On a machine that
/// has the checkout -- which is every machine this test is interesting on -- the
/// skip arm is unreachable, and an unreachable arm that decides whether a suite
/// reports anything is exactly the kind that quietly stops working. Same shape,
/// and the same reasoning, as `decide` in `gearbox-project`'s error-enum corpus
/// test.
#[derive(Debug, PartialEq, Eq)]
enum Reference {
    /// Read the examples out of this file.
    Read(PathBuf),
    /// No checkout, and none was demanded: say so and pass.
    Skip,
    /// No checkout, and the run said it required one.
    Demanded,
}

fn decide(found: Option<PathBuf>, required: bool) -> Reference {
    match (found, required) {
        (Some(path), _) => Reference::Read(path),
        (None, true) => Reference::Demanded,
        (None, false) => Reference::Skip,
    }
}

/// The examples, or `None` after announcing the skip.
///
/// One place, because three tests need the same decision and a skip spelled
/// differently in each is a skip somebody will eventually get wrong.
fn examples_or_skip(test: &str) -> Option<Vec<String>> {
    match decide(gdl_md(), required()) {
        Reference::Read(path) => Some(examples(&path)),
        Reference::Demanded => panic!(
            "GEARBOX_CORPUS_REQUIRED is set and no `gears-rust` checkout is reachable, \
             so the GDL reference could not be read"
        ),
        Reference::Skip => {
            eprintln!(
                "SKIP {test}: no `gears-rust` checkout reachable, so `docs/gdl.md` could \
                 not be read. Set GEARBOX_CORPUS_REQUIRED=1 to make this a failure."
            );
            None
        }
    }
}

#[test]
fn a_reachable_reference_is_read_whether_or_not_it_was_demanded() {
    let path = PathBuf::from("/somewhere/gears-rust/docs/gdl.md");
    assert_eq!(
        decide(Some(path.clone()), false),
        Reference::Read(path.clone())
    );
    assert_eq!(decide(Some(path.clone()), true), Reference::Read(path));
}

#[test]
fn a_missing_reference_skips_unless_the_run_demanded_one() {
    // The arm no machine with a checkout can reach, which is why it is tested
    // here rather than left to the filesystem to exercise.
    assert_eq!(decide(None, false), Reference::Skip);
    assert_eq!(decide(None, true), Reference::Demanded);
}

/// The fenced blocks under `## Examples`, in document order.
///
/// Deliberately anchored on the heading rather than taking the last two blocks
/// in the file: a new example added above would silently shift what is tested,
/// and a test that quietly changes subject is worse than one that fails.
fn examples(path: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(path).unwrap();
    let start = text
        .find("\n## Examples\n")
        .expect("`## Examples` is the heading the examples live under");
    let mut out = Vec::new();
    let mut rest = &text[start..];
    while let Some(open) = rest.find("\n```") {
        let after_fence = &rest[open + 4..];
        let body_start = after_fence.find('\n').map_or(0, |n| n + 1);
        let body = &after_fence[body_start..];
        let Some(close) = body.find("\n```") else {
            break;
        };
        out.push(body[..close].to_owned());
        rest = &body[close + 4..];
    }
    out
}

fn identity(path: &str) -> FileIdentity {
    FileIdentity {
        source: SourceId::new("gears-rust").unwrap(),
        gdl_path: RelPath::new(path).unwrap(),
        uri: gearbox_ir::file_uri(Path::new(path)),
        // No `load()` from a fragment: there is no directory for one to live
        // in, and resolving against the process's cwd would be worse than
        // refusing. An example needing `load()` would be a bad example.
        load_paths: None,
    }
}

fn errors(diagnostics: &[Diagnostic]) -> Vec<String> {
    diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .map(|d| format!("{} {}", d.code, d.message))
        .collect()
}

fn corpus() -> Option<PathBuf> {
    let mut dir: &Path = Path::new(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = dir.join("gears-rust");
        if candidate.join("gears").is_dir() {
            return candidate.canonicalize().ok();
        }
        dir = dir.parent()?;
    }
}

#[test]
fn the_examples_are_where_the_test_expects_them() {
    let Some(found) = examples_or_skip("the_examples_are_where_the_test_expects_them") else {
        return;
    };
    assert_eq!(
        found.len(),
        2,
        "`## Examples` should hold exactly the gear and the product example; \
         found {} block(s). If a third was added, this test must be taught \
         about it rather than silently testing the wrong two.",
        found.len()
    );
    assert!(
        found[0].contains("gear("),
        "the first example is the gear one"
    );
    assert!(
        found[1].contains("product("),
        "the second example is the product one"
    );
}

#[test]
fn the_gear_example_evaluates() {
    let Some(found) = examples_or_skip("the_gear_example_evaluates") else {
        return;
    };
    let source = &found[0];
    let outcome = GdlEngine::new().eval_gear(&identity("payments-audit/gear.gdl"), source);
    assert_eq!(
        errors(outcome.diagnostics.as_slice()),
        Vec::<String>::new(),
        "the gear example in the GDL reference does not evaluate"
    );
    assert!(outcome.value.is_some(), "it produced no declaration");
}

#[test]
fn the_product_example_evaluates_and_resolves() {
    // Against the corpus, because the faults this exists for are resolution
    // faults: a missing `secret_ref` and an unselected `cluster` gear are both
    // invisible to evaluation.
    let Some(found) = examples_or_skip("the_product_example_evaluates_and_resolves") else {
        return;
    };
    let Some(root) = corpus() else {
        assert!(
            !required(),
            "GEARBOX_CORPUS_REQUIRED is set and no `gears-rust` checkout is reachable"
        );
        eprintln!(
            "SKIP the_product_example_evaluates_and_resolves: no `gears-rust` checkout \
             reachable, so the example was evaluated but never resolved. Set \
             GEARBOX_CORPUS_REQUIRED=1 to make this a failure."
        );
        return;
    };

    let source = &found[1];
    let outcome = GdlEngine::new().eval_product(&identity("products/demo/product.gdl"), source);
    assert_eq!(
        errors(outcome.diagnostics.as_slice()),
        Vec::<String>::new(),
        "the product example in the GDL reference does not evaluate"
    );
    let intent = outcome.value.expect("it produced no intent");

    // **The example text is not rewritten**, which is what makes this a test of
    // the document rather than of a doctored copy. Its `at = path("…")` only
    // tells a caller where to look, and the caller here is this test: the corpus
    // is opened under the same source id the example declares.
    let catalogue = load_catalogue(&[
        SourceRoot::open(SourceId::new("gears-rust").unwrap(), root).expect("the corpus opens")
    ])
    .catalogue;

    // Every profile it declares, not just the default: an example that only
    // works on `dev` is an example that teaches a reader to write one.
    for profile in intent.profiles.keys() {
        let resolution = gearbox_engine::resolve::resolve(&catalogue, &intent, profile);
        assert_eq!(
            errors(resolution.diagnostics.as_slice()),
            Vec::<String>::new(),
            "the product example does not resolve for profile `{profile}`"
        );
    }

    // **And every section of it has an effect**, which is the assertion that
    // matters and the one this test was nearly written without.
    //
    // "No errors" passes on an example that declares things the resolver
    // silently ignores, and that is exactly what the example did: it bound a
    // contract for `api-contracts-consumer`, anchored an application on it and
    // declared two cluster profiles, while selecting neither that gear nor
    // `cluster`. All three produced nothing, no diagnostic said so, and a reader
    // copying any of the three would have learned a construct that does not
    // work. An example is a claim that the language does something; checking
    // only that it is not *rejected* is not checking the claim.
    let prod = intent
        .profiles
        .keys()
        .find(|id| id.as_str() == "prod")
        .expect("the example declares a `prod` profile");
    let resolved = gearbox_engine::resolve::resolve(&catalogue, &intent, prod);

    assert!(
        !resolved.bindings.is_empty(),
        "the example declares `bindings` and the resolution has none, so the \
         `bind(...)` it teaches did nothing"
    );
    assert!(
        !resolved.cluster.is_empty(),
        "the example declares `cluster_profiles` and nothing resolved against \
         them, so the `cluster_profile(...)` it teaches did nothing"
    );
    let names: Vec<&str> = resolved
        .partition
        .applications
        .iter()
        .map(|a| a.name.as_str())
        .collect();
    assert!(
        names.contains(&"audit"),
        "the example declares an `audit` application for `prod`, and prod \
         resolved to {names:?}"
    );
}
