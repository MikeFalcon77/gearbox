//! `gearbox/product/applyEdits` folds a batch onto one text, and a batch is not
//! a list of independent edits.
//!
//! Every [`PluginTarget`] is a *position* in the document the client previewed.
//! The fold rewrites that document as it goes, so a removal inside the batch
//! moves the entries the later edits address. This module pins the line between
//! the batches that are safe to fold and the ones that are refused.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use super::*;
use crate::protocol::{PluginTarget, ProductEdit};

const URI: &str = "file:///product.gdl";

/// Two connections under one host, so a batch can address both.
const TWO_CONNECTIONS: &str = r#"product(
    gears = [
        use_gear("api-gateway", source = "gears-rust"),
        use_gear("authn-resolver", source = "gears-rust",
            plugins = [
                plugin("static-authn-plugin", profiles = ["dev"]),
                plugin("oidc-authn-plugin", profiles = ["prod"]),
            ],
        ),
    ],
)
"#;

fn target(gear: &str, plugin: &str, entry_index: usize) -> PluginTarget {
    PluginTarget {
        gear: gear.to_owned(),
        plugin: plugin.to_owned(),
        entry_index,
    }
}

fn set_config(gear: &str, plugin: &str, entry_index: usize, key: &str) -> ProductEdit {
    ProductEdit::SetPluginConfig {
        target: target(gear, plugin, entry_index),
        key: key.to_owned(),
        value: Some(gearbox_ir::ConfigValue::Str("x".to_owned())),
    }
}

#[test]
fn a_batch_of_connection_edits_folds_onto_one_text() {
    // The ordinary Apply: a draft holds edits to several connections and they
    // all land, because none of them moves anything.
    let edited = apply_product_edits(
        URI,
        TWO_CONNECTIONS,
        &[
            set_config("authn-resolver", "static-authn-plugin", 0, "mode"),
            set_config("authn-resolver", "oidc-authn-plugin", 1, "issuer"),
        ],
    )
    .expect("both edits apply")
    .changed()
    .expect("changed")
    .to_owned();

    assert!(edited.contains(r#""mode": "x""#), "{edited}");
    assert!(edited.contains(r#""issuer": "x""#), "{edited}");
}

#[test]
fn a_removal_that_moves_a_later_edit_is_refused() {
    // Removing entry 0 slides entry 1 up, so the second edit would land on
    // whatever took its place. Refused rather than rebased: rebasing would
    // reinterpret what the person confirmed.
    let refusal = apply_product_edits(
        URI,
        TWO_CONNECTIONS,
        &[
            ProductEdit::RemovePlugin {
                target: target("authn-resolver", "static-authn-plugin", 0),
            },
            set_config("authn-resolver", "oidc-authn-plugin", 1, "issuer"),
        ],
    )
    .expect_err("a shifting batch must refuse");
    assert_eq!(
        refusal.as_slice()[0].code,
        gearbox_ir::DiagnosticCode::GdlEval
    );
}

#[test]
fn a_removal_below_an_edited_entry_does_not_move_it() {
    // Entry 1 removed, entry 0 edited: nothing before it moves, so this folds.
    apply_product_edits(
        URI,
        TWO_CONNECTIONS,
        &[
            ProductEdit::RemovePlugin {
                target: target("authn-resolver", "oidc-authn-plugin", 1),
            },
            set_config("authn-resolver", "static-authn-plugin", 0, "mode"),
        ],
    )
    .expect("a removal after the edited entry is safe");
}

#[test]
fn a_removal_under_another_host_does_not_move_anything_here() {
    // Positions are per host, so one host's removal says nothing about another's.
    let source = r#"product(
    gears = [
        use_gear("first-host", source = "gears-rust", plugins = [plugin("a-plugin")]),
        use_gear("second-host", source = "gears-rust", plugins = [plugin("b-plugin")]),
    ],
)
"#;
    apply_product_edits(
        URI,
        source,
        &[
            ProductEdit::RemovePlugin {
                target: target("first-host", "a-plugin", 0),
            },
            set_config("second-host", "b-plugin", 0, "mode"),
        ],
    )
    .expect("hosts do not shift each other");
}

#[test]
fn removing_one_connection_on_its_own_is_the_ordinary_case() {
    apply_product_edits(
        URI,
        TWO_CONNECTIONS,
        &[ProductEdit::RemovePlugin {
            target: target("authn-resolver", "static-authn-plugin", 0),
        }],
    )
    .expect("a lone removal folds");
}

#[test]
fn two_removals_under_one_host_are_refused() {
    // The second removal's position was counted before the first one ran.
    apply_product_edits(
        URI,
        TWO_CONNECTIONS,
        &[
            ProductEdit::RemovePlugin {
                target: target("authn-resolver", "static-authn-plugin", 0),
            },
            ProductEdit::RemovePlugin {
                target: target("authn-resolver", "oidc-authn-plugin", 1),
            },
        ],
    )
    .expect_err("two removals under one host must refuse");
}

#[test]
fn editing_the_entry_the_batch_also_removes_is_refused() {
    // Not a shift, but the same trap: after the removal that position holds a
    // different connection.
    apply_product_edits(
        URI,
        TWO_CONNECTIONS,
        &[
            ProductEdit::RemovePlugin {
                target: target("authn-resolver", "static-authn-plugin", 0),
            },
            set_config("authn-resolver", "static-authn-plugin", 0, "mode"),
        ],
    )
    .expect_err("editing a removed entry must refuse");
}

#[test]
fn a_batch_with_no_removal_is_never_refused_for_shifting() {
    // The guard must not cost the common case anything: gear-level edits and
    // connection edits together, no removal, all folded.
    apply_product_edits(
        URI,
        TWO_CONNECTIONS,
        &[
            ProductEdit::SetFeatures {
                gear: "api-gateway".to_owned(),
                features: vec!["tls".to_owned()],
            },
            set_config("authn-resolver", "static-authn-plugin", 0, "mode"),
            ProductEdit::SetPluginProfiles {
                target: target("authn-resolver", "oidc-authn-plugin", 1),
                profiles: vec!["prod".to_owned(), "staging".to_owned()],
            },
        ],
    )
    .expect("a batch without a removal folds");
}
