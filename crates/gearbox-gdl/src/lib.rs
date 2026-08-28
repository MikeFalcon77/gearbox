//! The Gears Description Language: a constrained Starlark-hosted domain API,
//! evaluated into the Gearbox typed model.
//!
//! This crate is the **only** one permitted to name a `starlark::` type. The
//! boundary is not stylistic: `starlark` is pre-1.0 and 0.14 broke hard from
//! 0.13, so containing every touch point here is what keeps an upgrade from
//! reaching the resolver and the generators. A test in `gearbox-engine`
//! asserts the boundary holds.
//!
//! GDL stays declarative through two layers, in this order:
//!
//! 1. **The dialect** rejects `def`, `lambda`, top-level control flow,
//!    f-strings, and type expressions at parse time, with a real span, for
//!    free.
//! 2. **A token scan** rejects the expression-level forms the dialect still
//!    admits -- comprehensions, ternaries, and `and`/`or`/`not`. That the
//!    dialect admits them is measured, not assumed: see
//!    `tests/declarative.rs`.

// Public only where a caller outside this crate genuinely needs it. Evaluation
// itself is reached through `GdlEngine`, so the modules that build and drive a
// starlark `Globals` stay internal: a `pub fn` returning one would hand a
// pre-1.0 host type to a crate the boundary test forbids from naming it.
//
// `globals` and `product` are the exception, and only for their `#[starlark_module]`
// vocabularies, which `tests/export_grammar.rs` reads to generate the editor's
// syntax highlighting. That test lives in this crate, so the containment holds.
pub mod declarative;
pub mod engine;
pub mod globals;
pub(crate) mod loader;
pub mod product;
pub(crate) mod product_intent;
pub mod records;
pub(crate) mod sink;
pub(crate) mod values;
pub mod vocabulary;

pub use engine::{EvalOutcome, FileIdentity, GdlEngine};
pub use sink::{GearDecl, ProductDecl};
pub use values::{GdlEnum, GdlNamespace};
