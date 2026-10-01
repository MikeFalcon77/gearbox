//! The receive loop itself: what it owns, and which messages it collapses.
//!
//! Driven over an in-memory connection with every message queued *before* the
//! loop runs, so what the loop does with a burst is a property of the loop and
//! not of how two threads happened to interleave.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::time::Duration;

use lsp_server::{Connection, Message, Notification};

use super::*;

fn did_open(uri: &str, text: &str) -> Message {
    Message::Notification(Notification {
        method: method::DID_OPEN.to_owned(),
        params: serde_json::json!({
            "textDocument": { "uri": uri, "languageId": "gdl", "version": 1, "text": text }
        }),
    })
}

fn did_change(uri: &str, version: i32, text: &str) -> Message {
    Message::Notification(Notification {
        method: method::DID_CHANGE.to_owned(),
        params: serde_json::json!({
            "textDocument": { "uri": uri, "version": version },
            "contentChanges": [{ "text": text }]
        }),
    })
}

fn exit() -> Message {
    Message::Notification(Notification {
        method: method::EXIT.to_owned(),
        params: serde_json::Value::Null,
    })
}

const GEAR: &str = "gear(\n  name = \"Demo\",\n  category = \"example\",\n  \
                    package = cargo(crate_name = \"demo\", lib = \"demo\", path = \".\"),\n)\n";

/// Every `publishDiagnostics` the server sent, by the version it claimed.
fn published_versions(client: &Connection) -> Vec<Option<i32>> {
    let mut versions = Vec::new();
    while let Ok(Message::Notification(notification)) = client.receiver.try_recv() {
        if notification.method == method::PUBLISH_DIAGNOSTICS {
            let params: PublishDiagnosticsParams =
                serde_json::from_value(notification.params).expect("publish params");
            versions.push(params.version);
        }
    }
    versions
}

/// The loop drops the connection before anybody can join the io threads.
///
/// **The deadlock this pins.** `IoThreads::join` waits on lsp-server's
/// message-dropper thread, which waits on the writer thread, which is parked in
/// `writer_receiver.into_iter()` until every `Sender<Message>` is gone -- and
/// `connection.sender` is one. `serve_stdio` used to run its loop with the
/// connection in its own scope and then join, so the join never returned: after
/// the client sent `exit` the process hung instead of exiting, on every clean
/// shutdown.
///
/// Draining to `Disconnected` here is the same wait, in the same order: it
/// finishes only once the server side of the channel has been dropped, which is
/// what `serve_connection` taking the connection by value guarantees.
#[test]
fn the_loop_releases_the_writer_channel_when_the_client_exits() {
    let (server, client) = Connection::memory();
    client.sender.send(exit()).unwrap();

    serve_connection(server, &mut new_state(&[])).expect("a clean exit is not an error");

    loop {
        match client.receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(_) => {}
            Err(crossbeam_err) => {
                assert!(
                    crossbeam_err.is_disconnected(),
                    "the writer channel is still open, which is what makes `IoThreads::join` \
                     hang: {crossbeam_err}"
                );
                break;
            }
        }
    }
}

/// A burst of edits to one document is evaluated once, at its newest text.
///
/// Every `didChange` costs a full parse and evaluation on this thread, and only
/// the last text is the document -- so three keystrokes queued behind one
/// evaluation used to be three evaluations, with `product/resolve` waiting behind
/// all of them. Asserted by the versions published: one for the open, one for the
/// newest change, and none for the two it superseded.
#[test]
fn a_burst_of_changes_to_one_document_publishes_once_for_the_newest() {
    let (server, client) = Connection::memory();
    let uri = "file:///a/gear.gdl";
    for message in [
        did_open(uri, GEAR),
        did_change(uri, 2, GEAR),
        did_change(uri, 3, GEAR),
        did_change(uri, 4, GEAR),
        exit(),
    ] {
        client.sender.send(message).unwrap();
    }

    serve_connection(server, &mut new_state(&[])).expect("a clean exit is not an error");

    assert_eq!(
        published_versions(&client),
        vec![Some(1), Some(4)],
        "the superseded edits must not be evaluated, and the surviving one must be the \
         newest text the client sent"
    );
}

/// Only edits to the *same* document are collapsed, and nothing else is lost.
///
/// The coalescing reads messages off the channel to find the superseded ones, so
/// everything it reads and does not use has to be served afterwards, in order --
/// a request dropped here would be a request the client never gets an answer to.
#[test]
fn coalescing_keeps_every_other_message_in_order() {
    let uri = "file:///a/gear.gdl";
    let other = "file:///b/gear.gdl";
    let Message::Notification(first) = did_change(uri, 2, "first") else {
        panic!("a notification");
    };
    let rest = vec![
        did_change(uri, 3, "second"),
        did_change(other, 9, "another document"),
        Message::Request(lsp_server::Request {
            id: RequestId::from(1),
            method: method::VALIDATE.to_owned(),
            params: serde_json::Value::Null,
        }),
        did_change(uri, 4, "newest"),
    ];

    let mut queued = std::collections::VecDeque::new();
    let survivor = coalesce_did_change(first, rest.into_iter(), &mut queued);

    assert_eq!(
        changed_uri(&survivor),
        Some(uri),
        "the survivor is an edit to the document the burst was about"
    );
    assert!(
        survivor.params["contentChanges"][0]["text"] == "newest",
        "and it is the newest of them: {:?}",
        survivor.params
    );

    let kept: Vec<String> = queued
        .iter()
        .map(|message| match message {
            Message::Notification(notification) => {
                format!("{} {:?}", notification.method, changed_uri(notification))
            }
            Message::Request(request) => request.method.clone(),
            Message::Response(_) => "response".to_owned(),
        })
        .collect();
    assert_eq!(
        kept,
        vec![
            format!("textDocument/didChange {:?}", Some(other)),
            method::VALIDATE.to_owned(),
        ],
        "an edit to another document and a request are not superseded by this burst"
    );
}
