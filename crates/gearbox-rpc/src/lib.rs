//! JSON-RPC 2.0 over stdio, with LSP `Content-Length` framing.
//!
//! One server backs both the Studio and the `.gdl` language client, which is why
//! the lifecycle is LSP-shaped (`initialize` / `shutdown` / `exit`) even though
//! most methods are Gearbox's own.
//!
//! **Nothing but JSON-RPC goes to stdout.** Every diagnostic, log line and panic
//! message goes to stderr or a `gearbox/log` notification. The CLI has been
//! written to that rule from the start; this crate is the reason it exists.
//!
//! Threads live here, not in the engine. `load_catalogue_staged` is synchronous
//! with a callback, and the callback writes notifications as events arrive, so
//! the engine keeps no dependency on parallelism (ADR
//! `cpt-gearbox-adr-staged-catalogue-loading`).

pub mod protocol;

use std::path::PathBuf;

use gearbox_engine::{Continue, LoadEvent, SourceRoot, load_catalogue_staged};
use gearbox_ir::SourceId;
use lsp_server::{Connection, ExtractError, Message, Notification, Request, RequestId, Response};

use crate::protocol::{
    Capabilities, CatalogueChanged, CatalogueLoadResult, InitializeParams, InitializeResult,
    LogParams, ProgressParams, ServerInfo, error_code, method,
};

/// Why the server could not run.
#[derive(Debug, thiserror::Error)]
pub enum ServeError {
    #[error("transport: {0}")]
    Transport(String),
    #[error("protocol: {0}")]
    Protocol(String),
}

/// Everything the server knows between requests.
struct State {
    roots: Vec<SourceRoot>,
    initialized: bool,
}

/// Run the server on stdio until the client says `exit`.
///
/// `default_roots` come from `--root` on the command line and are used when
/// `initialize` names none, so the CLI stays usable without a client.
///
/// # Errors
/// Returns [`ServeError`] when the transport fails or the client sends something
/// the framing cannot parse.
pub fn serve_stdio(default_roots: &[PathBuf]) -> Result<(), ServeError> {
    let (connection, io_threads) = Connection::stdio();
    let mut state = State {
        roots: open_roots(default_roots),
        initialized: false,
    };

    for message in &connection.receiver {
        match message {
            Message::Request(request) => {
                if connection
                    .handle_shutdown(&request)
                    .map_err(|e| ServeError::Protocol(e.to_string()))?
                {
                    break;
                }
                // `None` means the handler already answered: only the staged
                // load does that, and a second response with the same id would
                // be a protocol violation.
                if let Some(response) = dispatch(&connection, &mut state, request) {
                    connection
                        .sender
                        .send(Message::Response(response))
                        .map_err(|e| ServeError::Transport(e.to_string()))?;
                }
            }
            Message::Notification(notification) => {
                if notification.method == method::EXIT {
                    break;
                }
                // `initialized` and anything else the client volunteers: nothing
                // to do, and answering a notification is a protocol error.
            }
            Message::Response(_) => {
                // The server issues no requests yet, so a response is unsolicited.
            }
        }
    }

    io_threads
        .join()
        .map_err(|e| ServeError::Transport(e.to_string()))
}

/// Open every root, dropping those that cannot be opened.
///
/// A bad root is reported when a load is asked for rather than at startup: the
/// client may correct it in `initialize`, and refusing to start would leave no
/// channel to say why.
fn open_roots(paths: &[PathBuf]) -> Vec<SourceRoot> {
    paths
        .iter()
        .filter_map(|path| {
            let id = SourceId::new(default_source_id(path)).ok()?;
            SourceRoot::open(id, path).ok()
        })
        .collect()
}

/// A source id from the root's directory name, matching the CLI's rule.
fn default_source_id(path: &std::path::Path) -> String {
    path.canonicalize()
        .ok()
        .as_deref()
        .and_then(std::path::Path::file_name)
        .map(|n| n.to_string_lossy().to_lowercase())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "local".to_owned())
}

fn dispatch(connection: &Connection, state: &mut State, request: Request) -> Option<Response> {
    let id = request.id.clone();
    match request.method.as_str() {
        method::INITIALIZE => Some(match cast::<InitializeParams>(request) {
            Ok((id, params)) => initialize(state, id, &params),
            Err(e) => invalid_params(id, &e),
        }),
        method::CATALOGUE_LOAD => {
            if !state.initialized {
                return Some(error(
                    id,
                    error_code::NOT_INITIALIZED,
                    "`initialize` must come first",
                ));
            }
            if state.roots.is_empty() {
                return Some(error(
                    id,
                    error_code::WORKSPACE_NOT_OPEN,
                    "no source root is open; pass `roots` to `initialize` or `--root` to the CLI",
                ));
            }
            catalogue_load(connection, state, id)
        }
        other => Some(error(
            id,
            lsp_server::ErrorCode::MethodNotFound as i32,
            &format!("unknown method `{other}`"),
        )),
    }
}

fn initialize(state: &mut State, id: RequestId, params: &InitializeParams) -> Response {
    if !params.roots.is_empty() {
        state.roots = open_roots(&params.roots.iter().map(PathBuf::from).collect::<Vec<_>>());
    }
    state.initialized = true;

    ok(
        id,
        &InitializeResult {
            server_info: ServerInfo {
                name: "gearbox".to_owned(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
            },
            capabilities: Capabilities {
                catalogue: true,
                staged_catalogue: true,
                // Honest rather than aspirational: the client disables these
                // panels instead of rendering an empty one that looks broken.
                resolve: false,
                generate: false,
            },
        },
    )
}

/// Run a staged load, answering at the boundary and streaming the rest.
///
/// The response goes out when every description has been evaluated and no crate
/// has been parsed, which is exactly what a tree needs to render its shape. The
/// projections that follow arrive as notifications.
///
/// This runs on the request thread, so the connection's sender is used directly
/// for notifications. A long load therefore blocks further requests, which is
/// correct for now: cancellation is the answer to a slow load, and it needs the
/// request loop to be reading anyway. Moving the load to a worker is a change to
/// make when there is a second concurrent request worth serving.
fn catalogue_load(connection: &Connection, state: &State, id: RequestId) -> Option<Response> {
    let mut pending = Vec::new();
    let mut total = 0_u32;
    let mut completed = 0_u32;
    let mut answered = false;
    let mut declaration_diagnostics = Vec::new();

    let scan = load_catalogue_staged(&state.roots, &mut |event| {
        match event {
            LoadEvent::Discovered { total: n } => {
                total = u32::try_from(n).unwrap_or(u32::MAX);
            }
            LoadEvent::Declared(entry) => pending.push(entry.clone()),
            LoadEvent::DeclarationComplete { .. } => {
                // The tree has its whole shape and none of its badges: answer.
                let result = CatalogueLoadResult {
                    total,
                    pending: std::mem::take(&mut pending),
                    diagnostics: std::mem::take(&mut declaration_diagnostics),
                };
                drop(
                    connection
                        .sender
                        .send(Message::Response(ok(id.clone(), &result))),
                );
                answered = true;
            }
            LoadEvent::Projected(gear) => {
                completed += 1;
                notify(
                    connection,
                    method::CATALOGUE_CHANGED,
                    &CatalogueChanged {
                        gear: gear.clone(),
                        replaces: gear.gdl_path.as_str().to_owned(),
                    },
                );
                notify(
                    connection,
                    method::PROGRESS,
                    &ProgressParams {
                        token: "catalogue".to_owned(),
                        completed,
                        total,
                        done: false,
                    },
                );
            }
        }
        Continue::Yes
    });

    notify(
        connection,
        method::PROGRESS,
        &ProgressParams {
            token: "catalogue".to_owned(),
            completed,
            total,
            done: true,
        },
    );
    notify(
        connection,
        method::LOG,
        &LogParams {
            message: format!(
                "catalogue: {} gear(s), {} crate(s) parsed for {} request(s)",
                scan.catalogue.gears.len(),
                scan.crates_scanned,
                scan.scan_requests
            ),
        },
    );

    if answered {
        return None;
    }
    // No description evaluated, so the boundary never arrived. Answer with an
    // empty tree rather than leaving the client waiting.
    Some(ok(
        id,
        &CatalogueLoadResult {
            total,
            pending: Vec::new(),
            diagnostics: scan.catalogue.diagnostics.as_slice().to_vec(),
        },
    ))
}

fn notify<T: serde::Serialize>(connection: &Connection, method: &str, params: &T) {
    let params = serde_json::to_value(params).unwrap_or(serde_json::Value::Null);
    drop(connection.sender.send(Message::Notification(Notification {
        method: method.to_owned(),
        params,
    })));
}

fn cast<P: serde::de::DeserializeOwned>(
    request: Request,
) -> Result<(RequestId, P), ExtractError<Request>> {
    let method = request.method.clone();
    request.extract::<P>(&method)
}

fn ok<T: serde::Serialize>(id: RequestId, value: &T) -> Response {
    match serde_json::to_value(value) {
        Ok(result) => Response {
            id,
            response_result: Ok(result),
        },
        Err(e) => error(
            id,
            error_code::LOAD_FAILED,
            &format!("cannot serialize result: {e}"),
        ),
    }
}

fn error(id: RequestId, code: i32, message: &str) -> Response {
    Response {
        id,
        response_result: Err(lsp_server::ResponseError {
            code,
            message: message.to_owned(),
            data: None,
        }),
    }
}

fn invalid_params(id: RequestId, e: &ExtractError<Request>) -> Response {
    error(
        id,
        lsp_server::ErrorCode::InvalidParams as i32,
        &format!("{e:?}"),
    )
}
