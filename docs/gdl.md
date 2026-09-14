# GDL

GDL (Gears Description Language) is the declarative DSL a `gear.gdl` and a `product.gdl` are
written in. A file states facts; the resolver decides.

**The reference moved.** It now lives at `docs/gdl.md` in the **`gears-rust`** checkout, beside
the gears it describes and the people who write them: grammar, lexicon, namespaces, every
parameter signature, the curated diagnostics table, and the two worked examples.

Those examples are still executed from here:
`crates/gearbox-engine/tests/gdl_examples.rs` reads them out of the moved document and
evaluates them, skipping with a message when no `gears-rust` checkout is reachable.

What stays in this repository is the language's implementation, not its description:

| | |
|---|---|
| `crates/gearbox-gdl/src/globals.rs` | the `gear.gdl` vocabulary |
| `crates/gearbox-gdl/src/product.rs` | the `product.gdl` vocabulary |
| `crates/gearbox-gdl/src/vocabulary.rs` | the closed value sets |
| `crates/gearbox-gdl/src/declarative.rs` | the locked-down Starlark dialect and the refused keywords |

The editor's syntax vocabulary is generated from those same globals into
`ide/gearbox-studio/src/browser/gdl/generated/vocabulary.ts` by `make grammar`, so the
highlighter cannot colour a function the engine does not have.
