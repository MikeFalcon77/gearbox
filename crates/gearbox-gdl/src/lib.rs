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

pub mod declarative;
pub mod engine;
pub mod globals;
pub mod loader;
pub mod product;
pub mod product_intent;
pub mod records;
pub mod sink;
pub mod values;
pub mod vocabulary;

pub use engine::{EvalOutcome, FileIdentity, GdlEngine};
pub use product::product_globals;
pub use sink::{GearDecl, ProductDecl};
pub use values::{GdlEnum, GdlNamespace};
