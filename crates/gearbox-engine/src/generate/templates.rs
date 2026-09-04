//! The templates generation renders, and the overlay a product may supply.
//!
//! Builtins are compiled in via `include_str!`. A product that needs the
//! Dockerfile or a Helm template to match a house style drops a file at
//! `<dir of product.gdl>/templates/<key>.jinja` and that source wins. The
//! key *is* the contract: it is the path under this module's `templates/`
//! directory, without the `.jinja` suffix. A misspelled key is a file
//! nobody reads, which is why [`TemplateSet::get`] names the key it wanted
//! rather than silently falling through.
//!
//! **`generate` never reads the filesystem.** The CLI and the RPC server
//! load the overlay (see [`TemplateSet::load_for_product`]) and pass the
//! bytes in. That is what keeps `--dry-run` a preview of the same function
//! that writes, not a second implementation that happens to agree today.
//!
//! # Keys
//!
//! | key | produces |
//! |-----|----------|
//! | `main.rs` | host `processes/<p>/src/main.rs` |
//! | `worker_main.rs` | worker `processes/<p>/src/main.rs` |
//! | `registered_gears.rs` | `processes/<p>/src/registered_gears.rs` |
//! | `docker/Dockerfile` | `docker/<p>/Dockerfile` |
//! | `docker/dockerignore` | `docker/.dockerignore` |
//!
//! Helm keys arrive with the chart generator. An overlay for a key this
//! build does not yet render is kept and reported (so the operator can see
//! it was read) and otherwise unused.
//!
//! # Context per key
//!
//! Strict undefined behaviour is on: a typo in a product template fails
//! with the variable name, not a hole in the file. The variables each key
//! may name:
//!
//! - `main.rs`: `header`, `process`, `bin_name`, `gear_count`
//! - `worker_main.rs`: those plus `gear_name`, `version`
//! - `registered_gears.rs`: `header`, `idents`
//! - `docker/Dockerfile`: `header`, `rust_channel`, `crate_name`, `bin_name`,
//!   `process`, `out_rel`, `uid`, `ports`
//! - `docker/dockerignore`: `header`, `secret_dirs`

use std::collections::BTreeMap;
use std::path::Path;

use minijinja::{Environment, UndefinedBehavior};

use super::GenerateError;

/// A set of template sources, keyed as described in the module docs.
///
/// Empty means "use the builtins". That is the ordinary case: most products
/// never drop a `templates/` directory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TemplateSet {
    overrides: BTreeMap<String, String>,
}

impl TemplateSet {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Overlay already loaded. The caller read the files; this just holds them.
    #[must_use]
    pub fn from_overrides(overrides: BTreeMap<String, String>) -> Self {
        Self { overrides }
    }

    /// Walk `<dir of product.gdl>/templates/` for `*.jinja` files.
    ///
    /// Missing directory is empty, not an error: that is every product that
    /// has not opted into an overlay. A file that cannot be read *is* an
    /// error -- generating from a truncated override would produce a chart
    /// the operator cannot explain.
    ///
    /// # Errors
    /// Returns [`GenerateError::Io`] when the directory cannot be walked or a
    /// file cannot be read.
    pub fn load_for_product(product_file: &Path) -> Result<Self, GenerateError> {
        let Some(parent) = product_file.parent() else {
            return Ok(Self::new());
        };
        load_overrides(&parent.join("templates"))
    }

    /// The compiled-in source for `key`, if this build has one.
    #[must_use]
    pub fn builtin(key: &str) -> Option<&'static str> {
        match key {
            "main.rs" => Some(include_str!("templates/main.rs.jinja")),
            "worker_main.rs" => Some(include_str!("templates/worker_main.rs.jinja")),
            "registered_gears.rs" => Some(include_str!("templates/registered_gears.rs.jinja")),
            "docker/Dockerfile" => Some(include_str!("templates/docker/Dockerfile.jinja")),
            "docker/dockerignore" => Some(include_str!("templates/docker/dockerignore.jinja")),
            _ => None,
        }
    }

    /// The source that will actually render for `key`.
    ///
    /// An overlay wins. A key with no overlay and no builtin is a generator
    /// bug -- it asked for a name that is not in the contract -- so this
    /// returns an error rather than an empty string.
    ///
    /// # Errors
    /// Returns [`GenerateError::UnknownTemplate`] when neither the overlay
    /// nor the builtins know `key`.
    pub fn get(&self, key: &str) -> Result<&str, GenerateError> {
        if let Some(body) = self.overrides.get(key) {
            return Ok(body);
        }
        Self::builtin(key).ok_or_else(|| GenerateError::UnknownTemplate {
            key: key.to_owned(),
        })
    }

    /// Keys the product overlaid, in sorted order.
    ///
    /// Reported so an unexpected chart has a visible cause: without this,
    /// a house-style Dockerfile looks like a generator change.
    #[must_use]
    pub fn overridden(&self) -> Vec<String> {
        self.overrides.keys().cloned().collect()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.overrides.is_empty()
    }
}

/// Load every `*.jinja` under `dir` into a [`TemplateSet`].
///
/// The key is the path relative to `dir` with the `.jinja` suffix stripped,
/// always `/`-separated: an overlay on Windows has to match the same key
/// the builtins are registered under, and those keys are written with slashes.
fn load_overrides(dir: &Path) -> Result<TemplateSet, GenerateError> {
    if !dir.is_dir() {
        return Ok(TemplateSet::new());
    }

    let mut overrides = BTreeMap::new();
    for entry in walkdir::WalkDir::new(dir) {
        let entry = entry.map_err(|source| GenerateError::Io {
            what: "cannot walk template overrides",
            path: source.path().unwrap_or(dir).to_path_buf(),
            source: std::io::Error::other(source.to_string()),
        })?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jinja"))
        {
            continue;
        }
        let rel = path.strip_prefix(dir).unwrap_or(path);
        let mut key = super::paths::to_slash(rel);
        if let Some(dot) = key.rfind('.') {
            key.truncate(dot);
        }
        let body = std::fs::read_to_string(path).map_err(|source| GenerateError::Io {
            what: "cannot read template override",
            path: path.to_path_buf(),
            source,
        })?;
        overrides.insert(key, body);
    }
    Ok(TemplateSet { overrides })
}

/// Render one template, naming it in any error.
///
/// The result always ends in exactly one newline. minijinja strips the
/// template's own trailing newline, and a Rust file without one is a file
/// `rustfmt --check` and half the tools in the ecosystem complain about.
pub fn render(
    what: &'static str,
    source: &str,
    ctx: minijinja::Value,
) -> Result<String, GenerateError> {
    let mut env = Environment::new();
    // `Undefined` is an error rather than an empty string: a template variable
    // this module forgot to pass would otherwise render as a hole in a file,
    // and the compiler's complaint would be about syntax rather than about
    // the missing fact.
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    env.add_template(what, source)
        .and_then(|()| env.get_template(what)?.render(ctx))
        .map(|body| format!("{}\n", body.trim_end()))
        .map_err(|source| GenerateError::Template {
            what,
            source: Box::new(source),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_declared_key_has_a_builtin() {
        for key in [
            "main.rs",
            "worker_main.rs",
            "registered_gears.rs",
            "docker/Dockerfile",
            "docker/dockerignore",
        ] {
            assert!(
                TemplateSet::builtin(key).is_some(),
                "`{key}` is in the contract but has no builtin"
            );
        }
    }

    #[test]
    fn an_overlay_wins_over_the_builtin() {
        let mut overrides = BTreeMap::new();
        overrides.insert("main.rs".to_owned(), "overlaid".to_owned());
        let set = TemplateSet::from_overrides(overrides);
        assert_eq!(set.get("main.rs").unwrap(), "overlaid");
        assert_eq!(set.overridden(), vec!["main.rs"]);
    }

    #[test]
    fn a_missing_directory_is_an_empty_overlay() {
        let set = TemplateSet::load_for_product(Path::new("/no/such/product.gdl")).unwrap();
        assert!(set.is_empty());
    }

    #[test]
    fn an_unknown_key_is_an_error() {
        let err = TemplateSet::new().get("nope").unwrap_err();
        assert!(matches!(err, GenerateError::UnknownTemplate { .. }));
    }

    #[test]
    fn load_overrides_keys_by_path_without_jinja() {
        let dir = std::env::temp_dir().join(format!(
            "gbx-templates-{}-{}",
            std::process::id(),
            "overlay"
        ));
        let nested = dir.join("templates/docker");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("Dockerfile.jinja"), "FROM overlay\n").unwrap();
        let set = TemplateSet::load_for_product(&dir.join("product.gdl")).unwrap();
        assert_eq!(set.get("docker/Dockerfile").unwrap(), "FROM overlay\n");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
