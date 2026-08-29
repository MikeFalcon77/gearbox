//! The wire shapes, checked without a transport.
//!
//! The smoke test proves `vscode-jsonrpc` can read what the server writes. These
//! check the things that are easier to get wrong than to notice: which fields
//! serialize, and that an error code means what a client will think it means.

#![allow(
    clippy::unwrap_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use gearbox_rpc::protocol::{Capabilities, ProgressParams, error_code};

#[test]
fn application_error_codes_avoid_the_ones_lsp_defines() {
    // Reusing -32002 for "no workspace" would collide with LSP's
    // ServerNotInitialized, and a client mapping codes to messages would report
    // the wrong cause. -32001 is UnknownErrorCode for the same reason.
    for code in [
        error_code::NOT_INITIALIZED,
        error_code::WORKSPACE_NOT_OPEN,
        error_code::LOAD_FAILED,
        error_code::GENERATE_REFUSED,
    ] {
        assert_ne!(code, lsp_server::ErrorCode::ServerNotInitialized as i32);
        assert_ne!(code, -32001, "-32001 is LSP's UnknownErrorCode");
        assert!(
            (-32099..=-32000).contains(&code),
            "{code} must stay inside LSP's server-error window"
        );
    }
}

#[test]
fn capabilities_report_what_is_absent_rather_than_omitting_it() {
    // The client disables a panel on `false`. A missing field would leave it
    // rendering an empty Explain view that looks like a bug rather than a gap.
    let json = serde_json::to_value(Capabilities {
        catalogue: true,
        staged_catalogue: true,
        resolve: false,
        generate: false,
        writes: false,
    })
    .unwrap();

    for key in [
        "catalogue",
        "staged_catalogue",
        "resolve",
        "generate",
        "writes",
    ] {
        assert!(json.get(key).is_some(), "`{key}` must be present");
    }
    assert_eq!(json["resolve"], serde_json::json!(false));
}

#[test]
fn progress_omits_done_until_it_is_true() {
    // So a client can treat the presence of `done` as the terminal signal
    // without comparing counters that may both be zero on an empty tree.
    let running = serde_json::to_value(ProgressParams {
        token: "catalogue".to_owned(),
        completed: 1,
        total: 14,
        done: false,
    })
    .unwrap();
    assert!(running.get("done").is_none());

    let finished = serde_json::to_value(ProgressParams {
        token: "catalogue".to_owned(),
        completed: 14,
        total: 14,
        done: true,
    })
    .unwrap();
    assert_eq!(finished["done"], serde_json::json!(true));
}
