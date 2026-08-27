//! The `load()` sandbox: `cpt-gearbox-fr-gdl-sandbox`.
//!
//! `enable_load` is on because shared fragments are a legitimate need. What
//! makes that safe is that a fragment must live inside the declaring file's
//! source root -- otherwise a description could read any file the process can,
//! which is exactly the hermeticity the resolver's determinism rests on.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::fs;
use std::path::{Path, PathBuf};

use gearbox_gdl::engine::LoadPaths;
use gearbox_gdl::{FileIdentity, GdlEngine};
use gearbox_ir::{DiagnosticCode, RelPath, SourceId};

/// A source root laid out on disk, plus a secret alongside it that no
/// description should be able to reach.
struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("gearbox-sandbox-{name}"));
        drop(fs::remove_dir_all(&dir)); // may not exist yet; nothing to report
        fs::create_dir_all(dir.join("root/gears/demo")).expect("create fixture");

        // Outside the root: the thing the sandbox exists to keep out.
        fs::write(dir.join("outside.gdl"), "SECRET = \"leaked\"\n").expect("write outside");

        // Inside the root: a legitimate shared fragment.
        fs::write(
            dir.join("root/shared.gdl"),
            "SHARED = cargo(crate_name = \"cf-shared\", lib = \"shared\")\n",
        )
        .expect("write shared");

        Self { dir }
    }

    fn root(&self) -> PathBuf {
        self.dir.join("root")
    }

    /// An identity for a description at `root/gears/demo/gear.gdl`.
    fn identity(&self) -> FileIdentity {
        let base = self.root().join("gears/demo");
        FileIdentity {
            uri: format!("file://{}/gear.gdl", base.display()),
            source: SourceId::new("fixture").unwrap(),
            gdl_path: RelPath::new("gears/demo/gear.gdl").unwrap(),
            load_paths: Some(LoadPaths {
                base,
                root: self.root(),
            }),
        }
    }

    fn eval(&self, src: &str) -> Vec<DiagnosticCode> {
        GdlEngine::new()
            .eval_gear(&self.identity(), src)
            .diagnostics
            .iter()
            .map(|d| d.code)
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        drop(fs::remove_dir_all(&self.dir)); // best-effort cleanup
    }
}

#[test]
fn a_fragment_inside_the_root_loads() {
    let fx = Fixture::new("inside");
    // `//` addresses the source root explicitly.
    let codes = fx.eval(
        r#"
load("//shared.gdl", "SHARED")
gear(package = SHARED, name = "Demo")
"#,
    );
    assert!(
        codes.is_empty(),
        "a legitimate fragment should load: {codes:?}"
    );
}

#[test]
fn climbing_above_the_root_is_refused() {
    let fx = Fixture::new("escape");
    let codes = fx.eval(
        r#"
load("../../../outside.gdl", "SECRET")
gear(package = cargo(crate_name = "c", lib = "c"))
"#,
    );
    assert_eq!(
        codes,
        [DiagnosticCode::GdlLoadEscape],
        "an escape is a sandbox violation with its own code, not a generic eval error"
    );
}

#[test]
fn an_absolute_path_is_refused() {
    let fx = Fixture::new("absolute");
    let absolute = fx.dir.join("outside.gdl");
    let src = format!(
        r#"
load("{}", "SECRET")
gear(package = cargo(crate_name = "c", lib = "c"))
"#,
        absolute.display()
    );
    assert_eq!(fx.eval(&src), [DiagnosticCode::GdlLoadEscape]);
}

#[test]
fn a_root_relative_escape_is_refused() {
    let fx = Fixture::new("root-escape");
    // `//..` tries to climb out from the root itself.
    let codes = fx.eval(
        r#"
load("//../outside.gdl", "SECRET")
gear(package = cargo(crate_name = "c", lib = "c"))
"#,
    );
    assert_eq!(codes, [DiagnosticCode::GdlLoadEscape]);
}

#[test]
fn a_fragment_is_held_to_the_same_declarative_standard() {
    let fx = Fixture::new("fragment-conditional");
    // A fragment must not be able to smuggle in a construct the file loading it
    // could not have written itself.
    fs::write(fx.root().join("sneaky.gdl"), "X = 1 if True else 2\n").expect("write sneaky");

    let codes = fx.eval(
        r#"
load("//sneaky.gdl", "X")
gear(package = cargo(crate_name = "c", lib = "c"))
"#,
    );
    assert!(
        !codes.is_empty(),
        "a conditional in a fragment must be rejected"
    );
    assert!(
        codes.iter().all(|c| *c == DiagnosticCode::GdlEval),
        "reported as an eval failure naming the fragment: {codes:?}"
    );
}

#[test]
fn load_is_refused_outright_when_no_paths_are_configured() {
    // A caller evaluating a string literal has no directory for a fragment to
    // live in; resolving against the process's cwd would be worse than refusing.
    let identity = FileIdentity {
        uri: "file:///virtual/gear.gdl".to_owned(),
        source: SourceId::new("virtual").unwrap(),
        gdl_path: RelPath::new("gear.gdl").unwrap(),
        load_paths: None,
    };
    let out = GdlEngine::new().eval_gear(
        &identity,
        "load(\"//shared.gdl\", \"X\")\ngear(package = cargo(crate_name = \"c\", lib = \"c\"))\n",
    );
    assert!(out.value.is_none());
    assert!(out.diagnostics.has_errors());
}

#[test]
fn the_secret_never_becomes_reachable() {
    // The point of all of the above, stated once: no spelling of load() reaches
    // the file outside the root.
    let fx = Fixture::new("never");
    for attempt in [
        "../outside.gdl",
        "../../outside.gdl",
        "../../../outside.gdl",
        "//../outside.gdl",
        "./../outside.gdl",
        "gears/../../outside.gdl",
    ] {
        let src = format!(
            "load(\"{attempt}\", \"SECRET\")\ngear(package = cargo(crate_name = \"c\", lib = \"c\"))\n"
        );
        let codes = fx.eval(&src);
        assert!(
            !codes.is_empty(),
            "`{attempt}` was not refused -- the sandbox has a hole"
        );
        assert!(
            codes.contains(&DiagnosticCode::GdlLoadEscape)
                || codes.contains(&DiagnosticCode::GdlEval),
            "`{attempt}` produced {codes:?}"
        );
    }
    assert!(
        Path::new(&fx.dir.join("outside.gdl")).exists(),
        "sanity: the target exists"
    );
}
