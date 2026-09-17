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
    //
    // Over `error_code::ALL`, which lives beside the constants: this loop used to
    // name four of them, so the other half of the module was unchecked.
    for &code in error_code::ALL {
        assert_ne!(code, lsp_server::ErrorCode::ServerNotInitialized as i32);
        assert_ne!(code, -32001, "-32001 is LSP's UnknownErrorCode");
        assert!(
            (-32099..=-32000).contains(&code),
            "{code} must stay inside LSP's server-error window"
        );
    }

    // And each means one thing. A code copied onto a second constant would make
    // two causes indistinguishable to a client, which is the same failure the
    // window check is about.
    let mut seen = error_code::ALL.to_vec();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(
        seen.len(),
        error_code::ALL.len(),
        "two application error codes share a value"
    );
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
        text_document_sync: gearbox_rpc::lsp::SYNC_FULL,
        completion_provider: gearbox_rpc::protocol::CompletionOptions {
            resolve_provider: false,
        },
        hover_provider: true,
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

    // LSP's spelling, not Rust's. A language client reads this object as
    // `ServerCapabilities`, and `text_document_sync` would be a field it does
    // not know -- so it would fall back to "no sync", never send a `didOpen`,
    // and nothing would be underlined with no error anywhere to say why.
    assert_eq!(json["textDocumentSync"], serde_json::json!(1));
    assert!(json.get("text_document_sync").is_none());

    // Same rule for the two providers: a client that does not see these never
    // sends the request, so a snake_case key here is a feature that silently
    // does not exist.
    assert_eq!(
        json["completionProvider"],
        serde_json::json!({ "resolveProvider": false })
    );
    assert_eq!(json["hoverProvider"], serde_json::json!(true));
    assert!(json.get("completion_provider").is_none());
    assert!(json.get("hover_provider").is_none());
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
