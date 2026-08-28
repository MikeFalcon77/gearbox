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
use gearbox_ir::ProfileId;
use gearbox_ir::SourceId;
use lsp_server::{Connection, ExtractError, Message, Notification, Request, RequestId, Response};

use crate::protocol::{
    Capabilities, CatalogueChanged, CatalogueDiagnostics, CatalogueLoadResult, FailedRoot,
    InitializeParams, InitializeResult, LogParams, ProductLoadParams, ProductLoadResult,
    ProgressParams, ResolveParams, ResolveResult, ResolvedRoot, ServerInfo, ValidateParams,
    ValidateResult, error_code, method,
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
    /// The catalogue from the last load.
    ///
    /// Cached because resolving re-reads nothing else: a load parses every gear
    /// crate in the tree, and doing that again per resolve would make the
    /// Resolve button cost a second on a slice and ten on a real registry.
    /// Invalidated only by an explicit `gearbox/catalogue/load`, which is the
    /// same contract the CLI has -- there is no file watch yet, and pretending
    /// otherwise would be worse than saying so.
    catalogue: Option<gearbox_ir::Catalogue>,
    /// The roots that could not be opened, kept so the client can be told which
    /// and why rather than being handed a shorter list.
    failed_roots: Vec<FailedRoot>,
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
    let (roots, failed_roots) = open_roots(default_roots);
    let mut state = State {
        roots,
        catalogue: None,
        failed_roots,
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

/// Open every root, keeping the failures beside the successes.
///
/// A bad root is not fatal -- the client may correct it in `initialize`, and
/// refusing to start would leave no channel to say why -- but it is not silent
/// either. `.ok()` used to stand here, which turned a missing directory or an
/// unusable source id into a root that simply was not in the list, with the
/// cause discarded before anything could report it.
fn open_roots(paths: &[PathBuf]) -> (Vec<SourceRoot>, Vec<FailedRoot>) {
    let mut opened = Vec::with_capacity(paths.len());
    let mut failed = Vec::new();
    for path in paths {
        let spelling = path.display().to_string();
        match SourceId::new(default_source_id(path)) {
            Err(e) => failed.push(FailedRoot {
                path: spelling,
                error: e.to_string(),
            }),
            Ok(id) => match SourceRoot::open(id, path) {
                Ok(root) => opened.push(root),
                Err(e) => failed.push(FailedRoot {
                    path: spelling,
                    error: e.to_string(),
                }),
            },
        }
    }
    (opened, failed)
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
                // Naming the failures here as well as on `initialize`: a client
                // that ignored the `initialize` result would otherwise get
                // "no source root is open" for a root it did pass.
                let why = if state.failed_roots.is_empty() {
                    "no source root is open; pass `roots` to `initialize` or `--root` to the CLI"
                        .to_owned()
                } else {
                    format!(
                        "no source root is open; every root given failed to open: {}",
                        state
                            .failed_roots
                            .iter()
                            .map(|r| format!("{}: {}", r.path, r.error))
                            .collect::<Vec<_>>()
                            .join("; ")
                    )
                };
                return Some(error(id, error_code::WORKSPACE_NOT_OPEN, &why));
            }
            catalogue_load(connection, state, id)
        }
        method::PRODUCT_LOAD => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<ProductLoadParams>(request) {
                Ok((id, params)) => product_load(id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_RESOLVE => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<ResolveParams>(request) {
                Ok((id, params)) => resolve(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::VALIDATE => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<ValidateParams>(request) {
                Ok((id, params)) => validate(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        other => Some(error(
            id,
            lsp_server::ErrorCode::MethodNotFound as i32,
            &format!("unknown method `{other}`"),
        )),
    }
}

fn initialize(state: &mut State, id: RequestId, params: &InitializeParams) -> Response {
    if !params.roots.is_empty() {
        let (roots, failed) =
            open_roots(&params.roots.iter().map(PathBuf::from).collect::<Vec<_>>());
        state.roots = roots;
        state.failed_roots = failed;
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
                // M4 landed, so this is now true and the client's "needs the
                // resolver" notice disappears on its own -- which is what the
                // capability was for. `generate` stays false until M5.
                resolve: true,
                generate: false,
            },
            // `SourceRoot::root` is already canonicalized, which is what makes
            // it safe to join a `gdl_path` onto without `..` ambiguity.
            roots: state
                .roots
                .iter()
                .map(|root| ResolvedRoot {
                    id: root.id.as_str().to_owned(),
                    path: root.root.display().to_string(),
                })
                .collect(),
            failed_roots: state.failed_roots.clone(),
        },
    )
}

/// Refuse a request that cannot be served yet, or `None` to go ahead.
///
/// Factored out because all three of the new methods need the same two guards
/// and a copy each would be three places for them to drift apart.
fn require_ready(state: &State, id: &RequestId) -> Option<Response> {
    if !state.initialized {
        return Some(error(
            id.clone(),
            error_code::NOT_INITIALIZED,
            "`initialize` must come first",
        ));
    }
    if state.roots.is_empty() {
        return Some(error(
            id.clone(),
            error_code::WORKSPACE_NOT_OPEN,
            "no source root is open; pass `roots` to `initialize` or `--root` to the CLI",
        ));
    }
    None
}

/// Evaluate a `product.gdl`.
fn product_load(id: RequestId, params: &ProductLoadParams) -> Response {
    let path = PathBuf::from(&params.path);
    let scan = gearbox_engine::product::load_product(&path, None);
    match scan.intent {
        Some(intent) => ok(
            id,
            &ProductLoadResult {
                intent,
                diagnostics: scan.diagnostics.as_slice().to_vec(),
            },
        ),
        // No intent means the file is not a product at all, so there is nothing
        // partial to hand back -- unlike a resolution, which is useful even when
        // it reports errors.
        None => error_with_diagnostics(
            id,
            error_code::PRODUCT_LOAD_FAILED,
            &format!("`{}` could not be evaluated", params.path),
            scan.diagnostics.as_slice(),
        ),
    }
}

/// Resolve a product for one profile.
fn resolve(state: &mut State, id: RequestId, params: &ResolveParams) -> Response {
    let path = PathBuf::from(&params.path);
    let scan = gearbox_engine::product::load_product(&path, None);
    let mut diagnostics = scan.diagnostics.as_slice().to_vec();
    let Some(intent) = scan.intent else {
        return error_with_diagnostics(
            id,
            error_code::PRODUCT_LOAD_FAILED,
            &format!("`{}` could not be evaluated", params.path),
            &diagnostics,
        );
    };

    let profile = match params.profile.as_deref() {
        Some(named) => match ProfileId::new(named) {
            Ok(profile) => profile,
            Err(e) => {
                return error(
                    id,
                    error_code::RESOLVE_FAILED,
                    &format!("`{named}` is not a valid profile id: {e}"),
                );
            }
        },
        None => intent.default_profile.clone(),
    };

    // Built before the catalogue borrow, not after: `catalogue_for` needs
    // `&mut state` to fill the cache, and the sources read `state.roots`.
    let sources = state
        .roots
        .iter()
        .map(|root| (root.id.clone(), root.to_resolved()))
        .collect();
    let catalogue = catalogue_for(state);
    let resolution = gearbox_engine::resolve::resolve_at(catalogue, &intent, &profile, Some(&path));
    let product =
        gearbox_engine::resolve::product::assemble(catalogue, &intent, &resolution, sources);
    let explanation = gearbox_engine::resolve::product::explain(&resolution);

    // The product's own diagnostics are already inside it; the ones added here
    // are the description's, which resolution never sees.
    diagnostics.extend(resolution.diagnostics.as_slice().iter().cloned());
    ok(
        id,
        &ResolveResult {
            product: Some(product),
            explanation: Some(explanation),
            diagnostics,
        },
    )
}

/// Everything checkable without resolving.
fn validate(state: &mut State, id: RequestId, params: &ValidateParams) -> Response {
    let mut diagnostics = Vec::new();
    let intent = params.product.as_deref().and_then(|path| {
        let scan = gearbox_engine::product::load_product(&PathBuf::from(path), None);
        diagnostics.extend(scan.diagnostics.as_slice().iter().cloned());
        scan.intent
    });

    let product_path = params.product.as_deref().map(PathBuf::from);
    let report = gearbox_engine::validate::validate_at(
        &state.roots,
        intent.as_ref(),
        product_path.as_deref(),
    );
    diagnostics.extend(report.diagnostics.as_slice().iter().cloned());

    let count = |error: bool| {
        u32::try_from(
            diagnostics
                .iter()
                .filter(|d| d.severity.is_error() == error)
                .count(),
        )
        .unwrap_or(u32::MAX)
    };
    // Counted before the move, so the struct can be built in declaration order.
    let errors = count(true);
    let warnings = u32::try_from(
        diagnostics
            .iter()
            .filter(|d| d.severity == gearbox_ir::Severity::Warning)
            .count(),
    )
    .unwrap_or(u32::MAX);
    ok(
        id,
        &ValidateResult {
            diagnostics,
            errors,
            warnings,
        },
    )
}

/// The catalogue, loaded once and reused.
fn catalogue_for(state: &mut State) -> &gearbox_ir::Catalogue {
    state
        .catalogue
        .get_or_insert_with(|| gearbox_engine::load_catalogue(&state.roots).catalogue)
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
    // How many diagnostics went out with the response, so the follow-up sends
    // the rest and not all of them again.
    let mut already_sent = 0_usize;
    let mut disconnected = false;

    let scan = load_catalogue_staged(&state.roots, &mut |event| {
        match event {
            LoadEvent::Discovered { total: n } => {
                total = u32::try_from(n).unwrap_or(u32::MAX);
            }
            LoadEvent::Declared(entry) => pending.push(entry.clone()),
            LoadEvent::DeclarationComplete { diagnostics, .. } => {
                // The tree has its whole shape and none of its badges: answer.
                // The declaration diagnostics go with it -- an evaluation
                // failure is exactly what a client rendering the tree needs to
                // show, and there is no later response to carry it.
                already_sent = diagnostics.len();
                let result = CatalogueLoadResult {
                    total,
                    pending: std::mem::take(&mut pending),
                    diagnostics: diagnostics.to_vec(),
                };
                // `answered` only when the send succeeded. Setting it
                // unconditionally left a disconnected client unanswered *and*
                // suppressed the fallback response below.
                match connection
                    .sender
                    .send(Message::Response(ok(id.clone(), &result)))
                {
                    Ok(()) => answered = true,
                    Err(e) => {
                        eprintln!("gearbox: cannot answer catalogue/load: {e}");
                        disconnected = true;
                    }
                }
            }
            LoadEvent::Projected(gear) => {
                completed += 1;
                disconnected |= !notify(
                    connection,
                    method::CATALOGUE_CHANGED,
                    &CatalogueChanged {
                        gear: gear.clone(),
                        replaces: gear.gdl_path.as_str().to_owned(),
                    },
                );
                disconnected |= !notify(
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
        // A client that is gone will not read the rest of the load, and the
        // second pass is the expensive one.
        if disconnected {
            Continue::Stop
        } else {
            Continue::Yes
        }
    });

    // Everything the second pass produced. The response has already gone out, so
    // without this the projection and merge failures reach nobody.
    let remaining: Vec<gearbox_ir::Diagnostic> = scan
        .catalogue
        .diagnostics
        .iter()
        .skip(already_sent)
        .cloned()
        .collect();
    if answered && !remaining.is_empty() {
        notify(
            connection,
            method::CATALOGUE_DIAGNOSTICS,
            &CatalogueDiagnostics {
                diagnostics: remaining,
            },
        );
    }

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
    // No description evaluated (or the boundary send failed), so nothing has
    // answered this request. Answer with an empty tree rather than leaving the
    // client waiting -- if it is still there, the send loop reports the failure.
    Some(ok(
        id,
        &CatalogueLoadResult {
            total,
            pending: Vec::new(),
            diagnostics: scan.catalogue.diagnostics.as_slice().to_vec(),
        },
    ))
}

/// Send one notification. `false` means the peer is gone.
///
/// A serialization failure is logged rather than encoded as `Null`: a
/// notification whose params are `null` is one the client cannot tell from a
/// well-formed empty one, so it would read as "nothing happened".
fn notify<T: serde::Serialize>(connection: &Connection, method: &str, params: &T) -> bool {
    let params = match serde_json::to_value(params) {
        Ok(params) => params,
        Err(e) => {
            eprintln!("gearbox: cannot serialize `{method}` params: {e}");
            return true;
        }
    };
    match connection.sender.send(Message::Notification(Notification {
        method: method.to_owned(),
        params,
    })) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("gearbox: cannot send `{method}`: {e}");
            false
        }
    }
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

/// An error that carries the diagnostics explaining it.
///
/// A refusal whose message is "could not be evaluated" tells a client that
/// something is wrong and nothing about what. The diagnostics are the answer,
/// and they exist -- they were just being dropped on the floor with the failed
/// result. Serialization failure falls back to the plain error rather than
/// losing the refusal itself.
fn error_with_diagnostics(
    id: RequestId,
    code: i32,
    message: &str,
    diagnostics: &[gearbox_ir::Diagnostic],
) -> Response {
    let data = serde_json::json!({ "diagnostics": diagnostics });
    Response {
        id,
        response_result: Err(lsp_server::ResponseError {
            code,
            message: message.to_owned(),
            data: Some(data),
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
