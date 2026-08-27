//! Reading one `product.gdl` from disk into operator intent.
//!
//! Thin on purpose. `gearbox-gdl` does the evaluation and the internal
//! consistency checks; this only resolves the path, reads the bytes, and builds
//! the identity the diagnostics point at. Keeping I/O here is what lets the
//! evaluator be tested entirely from string literals.

use std::path::Path;

use gearbox_gdl::GdlEngine;
use gearbox_gdl::engine::{FileIdentity, LoadPaths};
use gearbox_ir::{
    Diagnostic, DiagnosticCode, Diagnostics, Location, ProductIntent, RelPath, SourceId,
};

/// The name a product description must have, so discovery is a filename match.
pub const PRODUCT_FILE: &str = "product.gdl";

/// A product intent plus everything that went wrong building it.
#[derive(Debug)]
pub struct ProductScan {
    /// `None` when the description could not be evaluated.
    pub intent: Option<ProductIntent>,
    pub diagnostics: Diagnostics,
}

/// Evaluate the `product.gdl` at `path`.
///
/// `root` is the boundary a `load()` may not cross. It defaults to the file's
/// own directory, which is the conservative choice: a product description that
/// wants to share fragments with a sibling has to say so by being rooted higher.
#[must_use]
pub fn load_product(path: &Path, root: Option<&Path>) -> ProductScan {
    let uri = format!("file://{}", path.display());
    let mut diagnostics = Diagnostics::new();

    let source = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) => {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::GdlEval,
                    format!("cannot read `{}`: {e}", path.display()),
                    "check the path and the file's permissions",
                )
                .at(Location::file(uri)),
            );
            diagnostics.finish();
            return ProductScan {
                intent: None,
                diagnostics,
            };
        }
    };

    let dir = path.parent().unwrap_or(Path::new("."));
    let root = root.unwrap_or(dir);

    // The product file's own path relative to the boundary. A product is not
    // inside a gear source root, so this is usually just the file name.
    let gdl_path = path
        .strip_prefix(root)
        .ok()
        .map(|r| {
            r.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .and_then(|text| RelPath::new(text).ok())
        .unwrap_or_else(RelPath::here);

    let identity = FileIdentity {
        uri,
        // A product is not read *from* a gear source; the id is a placeholder
        // that keeps FileIdentity uniform across both kinds of description.
        source: SourceId::new("product").unwrap_or_else(|_| unreachable!("`product` is kebab")),
        gdl_path,
        load_paths: Some(LoadPaths {
            base: dir.to_path_buf(),
            root: root.to_path_buf(),
        }),
    };

    let outcome = GdlEngine::new().eval_product(&identity, &source);
    diagnostics.extend(outcome.diagnostics);
    diagnostics.finish();

    ProductScan {
        intent: outcome.value,
        diagnostics,
    }
}
