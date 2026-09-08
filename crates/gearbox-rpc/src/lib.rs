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

#[cfg(test)]
#[path = "preview_tests.rs"]
mod preview_tests;

#[cfg(test)]
#[path = "write_gate_tests.rs"]
mod write_gate_tests;

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use gearbox_engine::{Continue, LoadEvent, SourceRoot, default_source_ids, load_catalogue_staged};
use gearbox_ir::{
    Diagnostic, ExplanationGraph, GearId, ProfileId, RelPath, ResolvedProduct, SourceId,
};
use lsp_server::{Connection, ExtractError, Message, Notification, Request, RequestId, Response};

use crate::protocol::{
    AddProfileParams, ApplyEditsParams, Capabilities, CatalogueChanged, CatalogueDiagnostics,
    CatalogueLoadResult, CreateProductParams, EditGearParams, EditGearResult, FailedRoot,
    GenerateApplyResult, GenerateFileParams, GenerateFileResult, GenerateParams,
    GeneratePlanResult, InitializeParams, InitializeResult, LockOnDisk, LockParams, LockResult,
    LogParams, ProductEdit, ProductLoadParams, ProductLoadResult, ProgressParams,
    RemoveProfileParams, ResolveParams, ResolvePreviewParams, ResolveResult, ResolvedRoot,
    ScaffoldGearParams, ScaffoldGearResult, ServerInfo, SetConfigParams, SetFeaturesParams,
    SetProfileFieldParams, ValidateParams, ValidateResult, error_code, method,
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
    /// Filled by `gearbox/catalogue/load` and replaced by nothing else, which is
    /// the same contract the CLI has -- there is no file watch yet, and
    /// pretending otherwise would be worse than saying so. Dropped when
    /// `initialize` changes the roots, because a catalogue belongs to the roots
    /// it was scanned from.
    catalogue: Option<gearbox_ir::Catalogue>,
    /// The roots that could not be opened, kept so the client can be told which
    /// and why rather than being handed a shorter list.
    failed_roots: Vec<FailedRoot>,
    initialized: bool,
    /// What the client declared at `initialize`.
    ///
    /// Recorded rather than inferred: the server cannot judge whether a caller
    /// should be allowed to write, so it holds the claim and refuses everything
    /// not claimed (`cpt-gearbox-fr-rpc-writes-opt-in`).
    allow_writes: bool,
    /// The directory the client declared as its workspace, if it declared one.
    workspace: Option<PathBuf>,
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
        // Read-only until a client says otherwise, which is the posture
        // `cpt-gearbox-fr-rpc-writes-opt-in` asks for.
        allow_writes: false,
        workspace: None,
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
    // Ids for the whole set at once, not one path at a time: the rule that makes
    // them distinct can only be applied to a set. See
    // `gearbox_engine::default_source_ids` for why two roots sharing an id is a
    // silent loss of gears rather than a cosmetic clash.
    for (path, id) in paths.iter().zip(default_source_ids(paths)) {
        let spelling = path.display().to_string();
        match SourceId::new(id) {
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

#[allow(clippy::cognitive_complexity)]
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
        method::PRODUCT_RESOLVE_PREVIEW => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<ResolvePreviewParams>(request) {
                Ok((id, params)) => resolve_preview(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_LOCK => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<LockParams>(request) {
                Ok((id, params)) => lock(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_ADD_GEAR => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<EditGearParams>(request) {
                Ok((id, params)) => edit_gear(state, id, &params, true),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_REMOVE_GEAR => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<EditGearParams>(request) {
                Ok((id, params)) => edit_gear(state, id, &params, false),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_SET_CONFIG => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<SetConfigParams>(request) {
                Ok((id, params)) => edit_set_config(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_SET_FEATURES => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<SetFeaturesParams>(request) {
                Ok((id, params)) => edit_set_features(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_ADD_PROFILE => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<AddProfileParams>(request) {
                Ok((id, params)) => edit_add_profile(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_REMOVE_PROFILE => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<RemoveProfileParams>(request) {
                Ok((id, params)) => edit_remove_profile(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_SET_PROFILE_FIELD => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<SetProfileFieldParams>(request) {
                Ok((id, params)) => edit_set_profile_field(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_APPLY_EDITS => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<ApplyEditsParams>(request) {
                Ok((id, params)) => edit_apply_edits(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::PRODUCT_CREATE => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<CreateProductParams>(request) {
                Ok((id, params)) => create_product(state, id, &params),
                Err(e) => invalid_params(id, &e),
            },
        }),
        method::GEAR_SCAFFOLD => Some(match require_ready(state, &id) {
            Some(refusal) => refusal,
            None => match cast::<ScaffoldGearParams>(request) {
                Ok((id, params)) => scaffold_gear(state, id, &params),
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
        method::GENERATE_PLAN | method::GENERATE_APPLY | method::GENERATE_FILE => {
            Some(dispatch_generate(state, request))
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
        let (roots, failed) =
            open_roots(&params.roots.iter().map(PathBuf::from).collect::<Vec<_>>());
        state.roots = roots;
        state.failed_roots = failed;
        // A catalogue is only ever the catalogue *of these roots*. Keeping it
        // across a re-`initialize` meant a second `initialize` naming different
        // roots -- which is exactly what a reconnecting client sends -- was
        // answered for the rest of the session out of a cache built from the
        // first set. Cheap to be wrong about, and impossible to notice.
        state.catalogue = None;
    }
    state.initialized = true;
    state.allow_writes = params.allow_writes;
    state.workspace = params.workspace.as_deref().map(PathBuf::from);

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
                // M4 and M5 landed, so both are true and the client's "needs
                // the resolver / generator" notices disappear on their own --
                // which is what the capabilities were for.
                resolve: true,
                generate: true,
                // Echoed back, so a client that forgot to ask for writes can see
                // that it forgot instead of finding out from a refusal later.
                writes: state.allow_writes,
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
        let why = if state.failed_roots.is_empty() {
            "no source root is open; pass `roots` to `initialize` or `--root` to the CLI".to_owned()
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
        return Some(error(id.clone(), error_code::WORKSPACE_NOT_OPEN, &why));
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
/// One resolution, and everything two callers need from it.
struct Resolved {
    product: ResolvedProduct,
    /// `templates = path(...)`, as the description wrote it.
    ///
    /// Carried here rather than read off the lock because it is an input to
    /// generation, not a resolution decision: the lock says what the product
    /// resolves to, and which directory the chart templates came from does not
    /// change that answer.
    templates: Option<String>,
    explanation: ExplanationGraph,
    /// The description's diagnostics plus the resolution's.
    diagnostics: Vec<Diagnostic>,
    profile: ProfileId,
}

/// Evaluate and resolve, or hand back the refusal to send.
///
/// Shared by `resolve` and `lock` so the two cannot answer about different
/// resolutions of the same request -- which is the whole reason the lock text is
/// not computed from a `ResolveResult` the client already has: the client would
/// then be re-serializing, and only the engine may decide the lock's bytes.
/// Resolve what is on disk, or what a caller proposes putting there.
///
/// `source` is the description's text when the answer is about text that does not
/// exist yet -- `gearbox/product/resolvePreview` supplies it. Everything else is
/// identical, deliberately: the roots, the catalogue and the sources are the real
/// ones, and the path is the real path, so a preview is an answer about *this*
/// product rather than about a hypothetical one somewhere else.
fn resolve_once(
    state: &mut State,
    id: &RequestId,
    path_str: &str,
    profile: Option<&str>,
    source: Option<&str>,
) -> Result<Resolved, Response> {
    let path = PathBuf::from(path_str);
    let scan = match source {
        Some(text) => gearbox_engine::product::eval_product_text(&path, None, text),
        None => gearbox_engine::product::load_product(&path, None),
    };
    let mut diagnostics = scan.diagnostics.as_slice().to_vec();
    let Some(intent) = scan.intent else {
        return Err(error_with_diagnostics(
            id.clone(),
            error_code::PRODUCT_LOAD_FAILED,
            &format!("`{path_str}` could not be evaluated"),
            &diagnostics,
        ));
    };

    let profile = match profile {
        Some(named) => match ProfileId::new(named) {
            Ok(profile) => profile,
            Err(e) => {
                return Err(error(
                    id.clone(),
                    error_code::RESOLVE_FAILED,
                    &format!("`{named}` is not a valid profile id: {e}"),
                ));
            }
        },
        None => intent.default_profile.clone(),
    };

    // Built before the catalogue borrow, not after: `catalogue_for` needs
    // The lock's `sources` need the catalogue *and* the roots at once: the digests
    // come from the catalogue, which is the thing that read the descriptions,
    // while the paths come from the roots. `catalogue_for` borrows `&mut state`
    // for as long as its result lives, so the roots are copied out first -- a
    // `SourceRoot` is an id, a path and a string, and there are one or two of
    // them.
    let roots = state.roots.clone();
    let catalogue = catalogue_for(state);
    let sources = gearbox_engine::lock_sources(&roots, catalogue, &path);
    let resolution = gearbox_engine::resolve::resolve_at(catalogue, &intent, &profile, Some(&path));
    let product =
        gearbox_engine::resolve::product::assemble(catalogue, &intent, &resolution, sources);
    let explanation = gearbox_engine::resolve::product::explain(catalogue, &intent, &resolution);

    // The product's own diagnostics are already inside it; the ones added here
    // are the description's, which resolution never sees.
    diagnostics.extend(resolution.diagnostics.as_slice().iter().cloned());
    Ok(Resolved {
        product,
        templates: intent.templates,
        explanation,
        diagnostics,
        profile,
    })
}

fn resolve(state: &mut State, id: RequestId, params: &ResolveParams) -> Response {
    match resolve_once(state, &id, &params.path, params.profile.as_deref(), None) {
        Err(refusal) => refusal,
        Ok(resolved) => ok(
            id,
            &ResolveResult {
                product: Some(resolved.product),
                explanation: Some(resolved.explanation),
                diagnostics: resolved.diagnostics,
            },
        ),
    }
}

/// Resolve the description a configurator is about to write, without writing it.
///
/// Answers "what would this product become" before the person commits to finding
/// out. The edits are applied to the text in memory with the same functions the
/// write path uses -- `add_gear` then `apply_product_edits` -- so the preview and
/// the write cannot drift: they are the same transformation, resolved once and
/// applied once.
///
/// No write gate, because there is no write: the file is read, never opened for
/// writing, and the lock is not touched.
fn resolve_preview(state: &mut State, id: RequestId, params: &ResolvePreviewParams) -> Response {
    let path = PathBuf::from(&params.path);
    let uri = gearbox_ir::file_uri(&path);
    let before = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) => {
            return error(
                id,
                error_code::PRODUCT_LOAD_FAILED,
                &format!("cannot read `{}`: {e}", params.path),
            );
        }
    };

    let mut proposed = before;
    if let Some(add) = params.add.as_ref() {
        match gearbox_gdl::edit::add_gear(&uri, &proposed, &add.gear, &add.source) {
            Ok(edit) => {
                if let Some(next) = edit.changed() {
                    next.clone_into(&mut proposed);
                }
            }
            Err(diagnostics) => {
                return error_with_diagnostics(
                    id,
                    error_code::EDIT_REFUSED,
                    &format!("`{}` could not be added for the preview", add.gear),
                    diagnostics.as_slice(),
                );
            }
        }
    }
    if !params.edits.is_empty() {
        match apply_product_edits(&uri, &proposed, &params.edits) {
            Ok(edit) => {
                if let Some(next) = edit.changed() {
                    next.clone_into(&mut proposed);
                }
            }
            Err(diagnostics) => {
                return error_with_diagnostics(
                    id,
                    error_code::EDIT_REFUSED,
                    "the proposed edits could not be applied for the preview",
                    diagnostics.as_slice(),
                );
            }
        }
    }

    match resolve_once(
        state,
        &id,
        &params.path,
        params.profile.as_deref(),
        Some(&proposed),
    ) {
        Err(refusal) => refusal,
        Ok(resolved) => ok(
            id,
            &ResolveResult {
                product: Some(resolved.product),
                explanation: Some(resolved.explanation),
                diagnostics: resolved.diagnostics,
            },
        ),
    }
}

/// The canonical lock text for one profile.
fn lock(state: &mut State, id: RequestId, params: &LockParams) -> Response {
    let resolved = match resolve_once(state, &id, &params.path, params.profile.as_deref(), None) {
        Err(refusal) => return refusal,
        Ok(resolved) => resolved,
    };
    // The same rule generation uses, so the lock compared against is the lock in
    // the tree generation writes. A different directory would be a diff nobody
    // could act on.
    let lock_path = default_out_root(state, params.out.as_deref(), &resolved)
        .map(|root| root.join("product.lock"));

    match gearbox_lock::write_canonical(&resolved.product) {
        Ok(canonical) => {
            let on_disk = lock_path
                .as_deref()
                .and_then(|path| compare_to_disk(path, &resolved.product));
            ok(
                id,
                &LockResult {
                    canonical,
                    lock_hash: resolved.product.product.lock_hash.clone(),
                    profile: resolved.profile.to_string(),
                    lock_path: lock_path
                        .as_deref()
                        .map(|p| p.display().to_string())
                        .unwrap_or_default(),
                    on_disk,
                    diagnostics: resolved.diagnostics,
                },
            )
        }
        // A product that resolved but cannot be written is a defect in the lock
        // writer, not in the description, so it carries the resolution's
        // diagnostics rather than pretending the description was at fault.
        Err(e) => error_with_diagnostics(
            id,
            error_code::RESOLVE_FAILED,
            &format!("the resolved product could not be written as a lock: {e}"),
            &resolved.diagnostics,
        ),
    }
}

/// Add or remove a gear in a product description.
///
/// Two gates before anything is read, let alone written, and they refuse in that
/// order because a client without write capability should not learn anything
/// about which paths exist:
///
/// 1. the client declared write capability at `initialize`;
/// 2. the path is inside a declared source root or beside a known product.
///
/// The write itself is temp-file-and-rename, so an interrupted run cannot leave a
/// truncated description behind -- ADR `cpt-gearbox-adr-authoring-ownership-tiers`
/// asks for transactional writes, and for one file that is what transactional
/// means.
fn edit_gear(state: &mut State, id: RequestId, params: &EditGearParams, add: bool) -> Response {
    if !state.allow_writes {
        return error(
            id,
            error_code::WRITES_NOT_ALLOWED,
            "this session declared no write capability, so nothing will be written; \
             pass `allow_writes: true` to `initialize` if the client is meant to edit files",
        );
    }

    let requested = PathBuf::from(&params.path);
    let path = match writable_path(state, &requested) {
        Ok(path) => path,
        Err(refusal) => return error(id, error_code::EDIT_REFUSED, &refusal),
    };

    let before = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) => {
            return error(
                id,
                error_code::EDIT_REFUSED,
                &format!("cannot read `{}`: {e}", params.path),
            );
        }
    };

    let uri = gearbox_ir::file_uri(&path);
    let outcome = if add {
        let Some(source_id) = params.source.as_deref() else {
            return error(
                id,
                error_code::EDIT_REFUSED,
                "adding a gear needs `source`: which declared source it comes from",
            );
        };
        gearbox_gdl::edit::add_gear(&uri, &before, &params.gear, source_id)
    } else {
        gearbox_gdl::edit::remove_gear(&uri, &before, &params.gear)
    };

    let edit = match outcome {
        Ok(edit) => edit,
        Err(diagnostics) => {
            return error_with_diagnostics(
                id,
                error_code::EDIT_REFUSED,
                &format!("`{}` could not be edited", params.path),
                diagnostics.as_slice(),
            );
        }
    };

    let after = edit.changed().unwrap_or(&before).to_owned();
    let changed = edit.changed().is_some();

    if changed
        && !params.dry_run
        && let Err(e) = write_atomically(&path, &after)
    {
        return error(
            id,
            error_code::EDIT_REFUSED,
            &format!("cannot write `{}`: {e}", params.path),
        );
    }

    ok(
        id,
        &EditGearResult {
            changed,
            written: changed && !params.dry_run,
            before,
            after,
            diagnostics: Vec::new(),
        },
    )
}

fn edit_set_config(state: &mut State, id: RequestId, params: &SetConfigParams) -> Response {
    edit_with(state, id, &params.path, params.dry_run, |uri, before| {
        gearbox_gdl::edit::set_gear_config(
            uri,
            before,
            &params.gear,
            &params.key,
            params.value.as_ref(),
        )
    })
}

fn edit_set_features(state: &mut State, id: RequestId, params: &SetFeaturesParams) -> Response {
    edit_with(state, id, &params.path, params.dry_run, |uri, before| {
        gearbox_gdl::edit::set_gear_features(uri, before, &params.gear, &params.features)
    })
}

fn edit_add_profile(state: &mut State, id: RequestId, params: &AddProfileParams) -> Response {
    let fields = params
        .fields
        .iter()
        .map(|f| (f.name.clone(), f.value.clone()))
        .collect::<Vec<_>>();
    edit_with(state, id, &params.path, params.dry_run, |uri, before| {
        gearbox_gdl::edit::add_profile(uri, before, &params.kind, &params.id, &fields)
    })
}

fn edit_remove_profile(state: &mut State, id: RequestId, params: &RemoveProfileParams) -> Response {
    edit_with(state, id, &params.path, params.dry_run, |uri, before| {
        gearbox_gdl::edit::remove_profile(uri, before, &params.id)
    })
}

fn edit_set_profile_field(
    state: &mut State,
    id: RequestId,
    params: &SetProfileFieldParams,
) -> Response {
    edit_with(state, id, &params.path, params.dry_run, |uri, before| {
        gearbox_gdl::edit::set_profile_field(
            uri,
            before,
            &params.id,
            &params.field,
            params.value.as_deref(),
        )
    })
}

fn edit_apply_edits(state: &mut State, id: RequestId, params: &ApplyEditsParams) -> Response {
    edit_with(state, id, &params.path, params.dry_run, |uri, before| {
        apply_product_edits(uri, before, &params.edits)
    })
}

/// Fold every edit onto the same text, in order. Fail the whole batch if any
/// step refuses — nothing is written until the fold succeeds.
fn apply_product_edits(
    uri: &str,
    before: &str,
    edits: &[ProductEdit],
) -> Result<gearbox_gdl::edit::Edit, gearbox_ir::Diagnostics> {
    let mut current = before.to_owned();
    let mut changed = false;
    for edit in edits {
        let step = match edit {
            ProductEdit::AddGear { gear, source } => {
                gearbox_gdl::edit::add_gear(uri, &current, gear, source)?
            }
            ProductEdit::RemoveGear { gear } => {
                gearbox_gdl::edit::remove_gear(uri, &current, gear)?
            }
            ProductEdit::AddSource { id, at } => {
                gearbox_gdl::edit::add_source(uri, &current, id, at)?
            }
            ProductEdit::SetConfig { gear, key, value } => {
                gearbox_gdl::edit::set_gear_config(uri, &current, gear, key, value.as_ref())?
            }
            ProductEdit::SetFeatures { gear, features } => {
                gearbox_gdl::edit::set_gear_features(uri, &current, gear, features)?
            }
            ProductEdit::AddPlugin { gear, plugin } => {
                gearbox_gdl::edit::add_gear_plugin(uri, &current, gear, plugin)?
            }
            ProductEdit::SetPlugins { gear, plugins } => {
                gearbox_gdl::edit::set_gear_plugins(uri, &current, gear, plugins)?
            }
            ProductEdit::SetProfileField {
                profile,
                field,
                value,
            } => gearbox_gdl::edit::set_profile_field(
                uri,
                &current,
                profile,
                field,
                value.as_deref(),
            )?,
        };
        if let Some(next) = step.changed() {
            next.clone_into(&mut current);
            changed = true;
        }
    }
    if changed {
        Ok(gearbox_gdl::edit::Edit::Changed { source: current })
    } else {
        Ok(gearbox_gdl::edit::Edit::Unchanged)
    }
}

fn edit_with(
    state: &mut State,
    id: RequestId,
    path_str: &str,
    dry_run: bool,
    apply: impl FnOnce(&str, &str) -> Result<gearbox_gdl::edit::Edit, gearbox_ir::Diagnostics>,
) -> Response {
    if !state.allow_writes {
        return error(
            id,
            error_code::WRITES_NOT_ALLOWED,
            "this session declared no write capability, so nothing will be written; \
             pass `allow_writes: true` to `initialize` if the client is meant to edit files",
        );
    }
    let requested = PathBuf::from(path_str);
    let path = match writable_path(state, &requested) {
        Ok(path) => path,
        Err(refusal) => return error(id, error_code::EDIT_REFUSED, &refusal),
    };
    let before = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) => {
            return error(
                id,
                error_code::EDIT_REFUSED,
                &format!("cannot read `{path_str}`: {e}"),
            );
        }
    };
    let uri = gearbox_ir::file_uri(&path);
    let edit = match apply(&uri, &before) {
        Ok(edit) => edit,
        Err(diagnostics) => {
            return error_with_diagnostics(
                id,
                error_code::EDIT_REFUSED,
                &format!("`{path_str}` could not be edited"),
                diagnostics.as_slice(),
            );
        }
    };
    respond_edit(id, &path, dry_run, before, edit)
}

#[allow(clippy::needless_pass_by_value)]
fn respond_edit(
    id: RequestId,
    path: &Path,
    dry_run: bool,
    before: String,
    edit: gearbox_gdl::edit::Edit,
) -> Response {
    let after = edit.changed().unwrap_or(&before).to_owned();
    let changed = edit.changed().is_some();
    if changed
        && !dry_run
        && let Err(e) = write_atomically(path, &after)
    {
        return error(
            id,
            error_code::EDIT_REFUSED,
            &format!("cannot write `{}`: {e}", path.display()),
        );
    }
    ok(
        id,
        &EditGearResult {
            changed,
            written: changed && !dry_run,
            before,
            after,
            diagnostics: Vec::new(),
        },
    )
}

fn create_product(state: &mut State, id: RequestId, params: &CreateProductParams) -> Response {
    if !state.allow_writes && !params.dry_run {
        return error(
            id,
            error_code::WRITES_NOT_ALLOWED,
            "this session declared no write capability, so nothing will be written; \
             pass `allow_writes: true` to `initialize` if the client is meant to create files",
        );
    }

    let requested = PathBuf::from(&params.path);
    let parent_input = requested
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = match writable_out_root(state, parent_input) {
        Ok(path) => path,
        Err(refusal) => return error(id, error_code::EDIT_REFUSED, &refusal),
    };
    let Some(file_name) = requested.file_name() else {
        return error(
            id,
            error_code::EDIT_REFUSED,
            &format!("`{}` does not name a file", params.path),
        );
    };
    let path = parent.join(file_name);
    if path.exists() {
        return error(
            id,
            error_code::EDIT_REFUSED,
            &format!(
                "`{}` already exists; create refuses to overwrite",
                path.display()
            ),
        );
    }

    let after = if let Some(clone_from) = params.clone_from.as_deref() {
        let requested = PathBuf::from(clone_from);
        let source_path = match writable_path(state, &requested) {
            Ok(path) => path,
            Err(refusal) => return error(id, error_code::EDIT_REFUSED, &refusal),
        };
        let source = match std::fs::read_to_string(&source_path) {
            Ok(text) => text,
            Err(e) => {
                return error(
                    id,
                    error_code::EDIT_REFUSED,
                    &format!("cannot read clone source `{clone_from}`: {e}"),
                );
            }
        };
        let uri = format!("file://{}", PathBuf::from(clone_from).display());
        match gearbox_gdl::edit::clone_product_text(
            &uri,
            &source,
            &params.id,
            &params.name,
            Some(params.version.as_str()),
        ) {
            Ok(text) => text,
            Err(diagnostics) => {
                return error_with_diagnostics(
                    id,
                    error_code::EDIT_REFUSED,
                    &format!("`{clone_from}` could not be cloned"),
                    diagnostics.as_slice(),
                );
            }
        }
    } else {
        gearbox_gdl::edit::render_product_template(&gearbox_gdl::edit::CreateProductParams {
            id: params.id.clone(),
            name: params.name.clone(),
            version: params.version.clone(),
            sources: params
                .sources
                .iter()
                .map(|s| (s.id.clone(), s.at.clone()))
                .collect(),
            profile_kind: params.profile_kind.clone(),
            profile_id: params.profile_id.clone(),
        })
    };

    // Refuse to write (or preview) text that does not evaluate as a product.
    // Escaping closes the practical hole; this catches a broken template itself.
    let uri = gearbox_ir::file_uri(&path);
    let identity = gearbox_gdl::FileIdentity {
        uri,
        source: SourceId::new("product").unwrap_or_else(|_| unreachable!("`product` is kebab")),
        gdl_path: RelPath::new("product.gdl")
            .unwrap_or_else(|_| unreachable!("`product.gdl` is a valid rel path")),
        load_paths: None,
    };
    let outcome = gearbox_gdl::GdlEngine::new().eval_product(&identity, &after);
    if outcome.value.is_none() {
        return error_with_diagnostics(
            id,
            error_code::EDIT_REFUSED,
            &format!(
                "`{}` does not evaluate as a product description",
                params.path
            ),
            outcome.diagnostics.as_slice(),
        );
    }

    if !params.dry_run {
        if let Err(e) = std::fs::create_dir_all(&parent) {
            return error(
                id,
                error_code::EDIT_REFUSED,
                &format!("cannot create `{}`: {e}", parent.display()),
            );
        }
        if let Err(e) = write_atomically(&path, &after) {
            return error(
                id,
                error_code::EDIT_REFUSED,
                &format!("cannot write `{}`: {e}", params.path),
            );
        }
    }

    ok(
        id,
        &EditGearResult {
            changed: true,
            written: !params.dry_run,
            before: String::new(),
            after,
            diagnostics: Vec::new(),
        },
    )
}

/// Scaffold a new gear crate: `gear.gdl`, `Cargo.toml`, and `src/lib.rs`.
///
/// ADR-0010 tier 0 / `GeneratedOnce`: preview via `FilePlan[]`, refuse when the
/// destination already exists, write only under `writable_out_root`.
fn scaffold_gear(state: &mut State, id: RequestId, params: &ScaffoldGearParams) -> Response {
    if !state.allow_writes && !params.dry_run {
        return error(
            id,
            error_code::WRITES_NOT_ALLOWED,
            "this session declared no write capability, so nothing will be written; \
             pass `allow_writes: true` to `initialize` if the client is meant to create files",
        );
    }

    let Ok(gear_id) = GearId::new(params.id.trim()) else {
        return error(
            id,
            error_code::EDIT_REFUSED,
            "gear id must be kebab-case (a single path segment, not `.` or `..`)",
        );
    };

    let dest_dir = PathBuf::from(&params.destination_dir);
    let parent = match writable_out_root(state, &dest_dir) {
        Ok(path) => path,
        Err(refusal) => return error(id, error_code::EDIT_REFUSED, &refusal),
    };
    let out_root = parent.join(gear_id.as_str());
    if out_root.exists() {
        return error(
            id,
            error_code::EDIT_REFUSED,
            &format!(
                "`{}` already exists; scaffold refuses to overwrite",
                out_root.display()
            ),
        );
    }

    // A locator on a `service` or `minimal` scaffold has nowhere to be written,
    // so it is a client mistake rather than a field to ignore. Refused rather
    // than dropped: silently discarding half a request is how a client learns
    // the wrong contract.
    if params.plugin.is_some() && params.kind != crate::protocol::GearKind::Plugin {
        return error(
            id,
            error_code::EDIT_REFUSED,
            "`plugin` describes what a plugin fills, so it only applies to `kind = \"plugin\"`",
        );
    }

    let files = match scaffold_gear_files(params) {
        Ok(files) => files,
        Err(message) => return error(id, error_code::EDIT_REFUSED, &message),
    };

    // Refuse to scaffold text that does not evaluate as a gear declaration.
    let gdl = files
        .iter()
        .find(|(rel, _, _)| rel == "gear.gdl")
        .map_or("", |(_, body, _)| body.as_str());
    let uri = gearbox_ir::file_uri(&out_root.join("gear.gdl"));
    let identity = gearbox_gdl::FileIdentity {
        uri,
        source: SourceId::new("scaffold").unwrap_or_else(|_| unreachable!("`scaffold` is kebab")),
        gdl_path: RelPath::new("gear.gdl")
            .unwrap_or_else(|_| unreachable!("`gear.gdl` is a valid rel path")),
        load_paths: None,
    };
    let outcome = gearbox_gdl::GdlEngine::new().eval_gear(&identity, gdl);
    if outcome.value.is_none() {
        return error_with_diagnostics(
            id,
            error_code::EDIT_REFUSED,
            "scaffolded `gear.gdl` does not evaluate as a gear description",
            outcome.diagnostics.as_slice(),
        );
    }

    let mut plans = Vec::with_capacity(files.len());
    for (rel, body, kind) in &files {
        let path = RelPath::new(rel).unwrap_or_else(|_| unreachable!("scaffold paths are valid"));
        let entry = gearbox_ir::FileEntry::text(
            path.clone(),
            body.clone(),
            *kind,
            gearbox_ir::Ownership::GeneratedOnce,
        );
        plans.push(gearbox_ir::FilePlan {
            path,
            action: gearbox_ir::FileAction::Create,
            ownership: gearbox_ir::Ownership::GeneratedOnce,
            kind: *kind,
            blake3: entry.digest(),
            preview_available: true,
        });
    }

    if !params.dry_run {
        if let Err(e) = std::fs::create_dir_all(out_root.join("src")) {
            return error(
                id,
                error_code::EDIT_REFUSED,
                &format!("cannot create `{}`: {e}", out_root.join("src").display()),
            );
        }
        for (rel, body, _) in &files {
            let path = out_root.join(rel);
            if let Err(e) = write_atomically(&path, body) {
                return error(
                    id,
                    error_code::EDIT_REFUSED,
                    &format!("cannot write `{}`: {e}", path.display()),
                );
            }
        }
    }

    ok(
        id,
        &ScaffoldGearResult {
            plan: GeneratePlanResult {
                plans,
                diagnostics: Vec::new(),
                out_root: out_root.display().to_string().replace('\\', "/"),
                // Scaffolding renders no product templates, so nothing can be
                // overridden here -- an empty list is the truth, not a stub.
                overridden_templates: Vec::new(),
            },
            // The text this method already built and evaluated. Carried because
            // the three file *paths* are the same for all three kinds, so a
            // preview of paths alone showed the shape choice doing nothing.
            gear_gdl: gdl.to_owned(),
        },
    )
}

/// One file a scaffold will write: its path under the gear directory, its body,
/// and what kind of file it is.
///
/// Named rather than left as a triple because it is threaded through the plan,
/// the preview and the write, and `(String, String, FileKind)` says nothing about
/// which `String` is the path.
type ScaffoldFile = (String, String, gearbox_ir::FileKind);

/// Minimal gear scaffold contents: description, stub crate, empty lib.
fn scaffold_gear_files(params: &ScaffoldGearParams) -> Result<Vec<ScaffoldFile>, String> {
    let crate_name = GearId::new(params.id.trim())
        .map_err(|_| "gear id must be kebab-case".to_owned())?
        .to_string();
    let lib_name = crate_name.replace('-', "_");
    if !is_semver(&params.version) {
        return Err("version must be a semver triple like `0.1.0`".to_owned());
    }

    let name = gearbox_gdl::edit::quote_string(&params.name);
    let crate_quoted = gearbox_gdl::edit::quote_string(&crate_name);
    let lib_quoted = gearbox_gdl::edit::quote_string(&lib_name);
    let gdl = format!(
        r#"# Scaffolded gear description for {comment}.
#
# Id comes from #[toolkit::gear] once macros land. Until then this file names
# the package the catalogue will join against.

gear(
    name = {name},
    package = cargo(
        crate_name = {crate_quoted},
        lib = {lib_quoted},
        path = ".",
    ),
{shape})
"#,
        comment = params.name.replace(['\n', '\r'], " "),
        shape = gdl_shape(params.kind, params.plugin.as_ref()),
    );

    let cargo = format!(
        r#"[package]
name = {crate_toml}
version = {version_toml}
edition = "2021"

[lib]
name = {lib_toml}
path = "src/lib.rs"
"#,
        crate_toml = toml_basic_string(&crate_name),
        version_toml = toml_basic_string(&params.version),
        lib_toml = toml_basic_string(&lib_name),
    );

    Ok(vec![
        ("gear.gdl".to_owned(), gdl, gearbox_ir::FileKind::Text),
        ("Cargo.toml".to_owned(), cargo, gearbox_ir::FileKind::Toml),
        (
            "src/lib.rs".to_owned(),
            lib_stub(params.kind),
            gearbox_ir::FileKind::Rust,
        ),
    ])
}

/// The declarations one shape of gear needs, after `package`.
///
/// **Comments, not values, and that is the whole design.** Every one of these
/// fields is either projected from Rust or checked against it: a `category` this
/// method invented would draw GBX's unknown-category warning on the first load, a
/// `plugin_interface` naming no `pub trait` is refused outright (GBX0516), and an
/// `sdk` locator pointing at a directory that does not exist makes the gear fail
/// to load. So the shape's job is to put the next declaration **where it goes**,
/// with the sentence that says what decides it -- and to leave it commented until
/// there is something true to write. A scaffold that emitted placeholders would
/// hand its author a description to repair rather than one to fill in.
fn gdl_shape(
    kind: crate::protocol::GearKind,
    plugin: Option<&crate::protocol::PluginScaffold>,
) -> std::borrow::Cow<'static, str> {
    // A host chosen from a loaded catalogue makes the locator a fact, so it is
    // written live rather than as the comment the rest of this function returns.
    // The comment exists because an `sdk` pointing nowhere makes the gear fail to
    // load; a path the engine itself projected does not point nowhere.
    if let (crate::protocol::GearKind::Plugin, Some(plugin)) = (kind, plugin) {
        return std::borrow::Cow::Owned(plugin_shape(plugin));
    }
    std::borrow::Cow::Borrowed(gdl_shape_commented(kind))
}

/// The live `sdk` locator, and `plugin_interface` only when it was given.
///
/// Rendered through `quote_string`, not `{:?}`: this text is evaluated as GDL
/// immediately afterwards, and Rust's debug escaping is not Starlark's. A path
/// with a backslash in it would otherwise produce a file that reads fine and
/// does not evaluate.
fn plugin_shape(plugin: &crate::protocol::PluginScaffold) -> String {
    use gearbox_gdl::edit::quote_string;

    let interface = plugin
        .plugin_interface
        .as_deref()
        .map_or_else(String::new, |name| {
            format!(
                r"
    # Declared because reading the `impl` cannot decide -- a crate implementing
    # two plugin interfaces. A name no `pub trait` in the sdk backs is refused
    # (GBX0516), so this is an escape hatch and never a declaration of intent.
    plugin_interface = {},
",
                quote_string(name)
            )
        });

    format!(
        r#"
    # `description`, `category` and `visibility` are yours to fill in.
    #
    # description = "What this plugin does, in one sentence.",
    # category = "core-platform-integration",
    # visibility = "internal",

    # **The locator that makes this a plugin**, written from the host you chose.
    # Which of the SDK's traits this crate implements is read from the `impl`,
    # not declared here.
    sdk = cargo(
        crate_name = {crate_name},
        lib = {lib},
        path = {path},
    ),
{interface}
    # A plugin's own `vendor` and `priority` are the join key its host's selector
    # matches against, and both are read from this crate's config struct. What is
    # declared is only that they are worth showing an integrator.
    #
    # config_schema = config(exposes = ["vendor", "priority"]),
"#,
        crate_name = quote_string(&plugin.crate_name),
        lib = quote_string(&plugin.lib_ident),
        path = quote_string(&plugin.path),
    )
}

fn gdl_shape_commented(kind: crate::protocol::GearKind) -> &'static str {
    match kind {
        // What this method has always written: a crate and a name, with the one
        // hint that applies to every gear.
        crate::protocol::GearKind::Minimal => {
            r#"
    # Uncomment once this gear reads configuration. `exposes` is the only half
    # written here: which settings are worth putting in front of an integrator.
    # Their names, types, defaults and doc comments are read from the struct the
    # gear deserializes into, which is found from the `ctx.config*()` call in
    # `impl Gear::init` -- so nothing about the struct is repeated here.
    #
    # config_schema = config(exposes = ["bind_addr"]),
"#
        }
        // A gear that does something on its own. The three declared fields every
        // service in the corpus carries, then the contract and configuration
        // hints -- `provides` and `consumes` are declared, unlike `runtime_caps`
        // and `colocated_deps`, which #[toolkit::gear] owns and GBX0210 refuses
        // to see restated here.
        crate::protocol::GearKind::Service => {
            r#"
    # The three fields a described service carries beyond its crate. `category`
    # is checked against the known set and warns when it is not one of them;
    # `visibility = "public"` is what makes a gear selectable by a product.
    #
    # description = "What this gear does, in one sentence.",
    # category = "core-platform-integration",
    # visibility = "internal",

    # Contracts are declared -- unlike `runtime_caps` and `colocated_deps`, which
    # #[toolkit::gear] owns and GBX0210 refuses to see restated here. `provides`
    # names the trait this gear implements for others; `consumes` names one it
    # needs, and the transports come from the provider's side.
    #
    # provides = [provide(contract = "PaymentApi", version = "v1")],
    # consumes = [consume(contract = "TenantApi", version = "v1")],

    # Uncomment once this gear reads configuration. `exposes` is the only half
    # written here: which settings are worth putting in front of an integrator.
    # Their names, types, defaults and doc comments are read from the struct the
    # gear deserializes into, which is found from the `ctx.config*()` call in
    # `impl Gear::init` -- so nothing about the struct is repeated here.
    #
    # config_schema = config(exposes = ["bind_addr"]),
"#
        }
        // A gear that fills another gear's extension point. `sdk` is the locator
        // that decides *which* point: the SDK crate declares the plugin-API
        // trait, and which one this crate implements is read from the `impl`
        // rather than declared. Both stay commented until the SDK path is real --
        // an `sdk` pointing nowhere fails the load, and `plugin_interface` naming
        // a trait the SDK does not declare is GBX0516.
        crate::protocol::GearKind::Plugin => {
            r#"
    # description = "What this plugin does, in one sentence.",
    # category = "core-platform-integration",
    # visibility = "internal",

    # **The locator that makes this a plugin.** The SDK crate declares the
    # plugin-API trait; which of its traits this crate implements is read from the
    # `impl`, not declared here. Point `path` at the SDK crate before uncommenting
    # -- a locator to a directory that does not exist makes this gear fail to
    # load.
    #
    # sdk = cargo(
    #     crate_name = "cf-gears-authn-resolver-sdk",
    #     lib = "authn_resolver_sdk",
    #     path = "../../authn-resolver-sdk",
    # ),

    # Only when reading the `impl` cannot decide -- a crate implementing two
    # plugin interfaces. A name no `pub trait` in the sdk backs is refused
    # (GBX0516), so this is an escape hatch and never a declaration of intent.
    #
    # plugin_interface = "AuthNResolverPluginClient",

    # A plugin's own `vendor` and `priority` are the join key its host's selector
    # matches against, and both are read from this crate's config struct. What is
    # declared is only that they are worth showing an integrator.
    #
    # config_schema = config(exposes = ["vendor", "priority"]),
"#
        }
    }
}

/// The `src/lib.rs` stub for one shape.
///
/// A comment rather than code, for the reason the shapes are comments: the
/// toolkit's location and version are not known here, so `#[toolkit::gear]` would
/// be written against a dependency this method cannot add -- a crate that does
/// not compile is worse than one that is empty. What the stub carries is the
/// order of the next steps, which is the part a person actually looks up.
fn lib_stub(kind: crate::protocol::GearKind) -> String {
    match kind {
        crate::protocol::GearKind::Minimal => String::from(
            "// Scaffolded lib.\n\
             // Gear macros (#[toolkit::gear], provides/consumes) come next.\n",
        ),
        crate::protocol::GearKind::Service => String::from(
            "// Scaffolded service gear.\n\
             //\n\
             // Next, in this order:\n\
             //   1. add the toolkit dependency to Cargo.toml;\n\
             //   2. #[toolkit::gear(name = \"...\")] on the gear struct -- the id,\n\
             //      runtime capabilities and co-located deps are projected from it,\n\
             //      and restating them in gear.gdl is refused (GBX0210);\n\
             //   3. impl Gear, whose `init` is where a single ctx.config*() call\n\
             //      links this gear to its configuration struct;\n\
             //   4. uncomment `config_schema` in gear.gdl once that struct exists.\n",
        ),
        crate::protocol::GearKind::Plugin => String::from(
            "// Scaffolded plugin gear.\n\
             //\n\
             // Next, in this order:\n\
             //   1. add the host's SDK crate to Cargo.toml, and point `sdk` in\n\
             //      gear.gdl at it -- that locator is what decides which extension\n\
             //      point this gear fills;\n\
             //   2. impl the SDK's plugin-API trait. Which one you implement is\n\
             //      *read* from this file, so there is nothing to declare;\n\
             //   3. register the vendor and priority this plugin answers under --\n\
             //      they are the join key the host's `vendor` selector matches;\n\
             //   4. list this gear under its host's `plugins = [...]` in the\n\
             //      product. A plugin under a host that does not declare its point\n\
             //      is refused (GBX0518).\n",
        ),
    }
}

/// Whether a path may be written, and why not when it may not.
///
/// `cpt-gearbox-fr-rpc-writes-opt-in` requires rejecting "any path outside the
/// declared workspace or source roots". A product description lives in neither a
/// gear source root nor nowhere -- it sits beside the products -- which is why the
/// client declares a workspace at `initialize` and this checks against both.
///
/// If nothing was declared, nothing is writable. Failing closed is the only
/// defensible default for a method that changes files.
fn writable_path(state: &State, path: &Path) -> Result<PathBuf, String> {
    let Ok(canonical) = path.canonicalize() else {
        return Err(format!("`{}` does not exist", path.display()));
    };
    if canonical.extension().and_then(|e| e.to_str()) != Some("gdl") {
        return Err(format!(
            "`{}` is not a `.gdl` description; this method edits descriptions only",
            path.display()
        ));
    }

    let mut allowed = Vec::new();
    for root in &state.roots {
        match root.root.canonicalize() {
            Ok(path) => allowed.push(path),
            Err(e) => {
                return Err(format!(
                    "cannot canonicalize source root `{}`: {e}",
                    root.root.display()
                ));
            }
        }
    }
    if let Some(workspace) = state.workspace.as_ref() {
        match workspace.canonicalize() {
            Ok(path) => allowed.push(path),
            Err(e) => {
                return Err(format!(
                    "cannot canonicalize workspace `{}`: {e}",
                    workspace.display()
                ));
            }
        }
    }

    if allowed.is_empty() {
        return Err(
            "no workspace and no source root were declared, so no path is writable".to_owned(),
        );
    }
    if allowed.iter().any(|root| canonical.starts_with(root)) {
        Ok(canonical)
    } else {
        Err(format!(
            "`{}` is outside the declared workspace and every source root",
            path.display()
        ))
    }
}

/// Whether a generation output root may be written, and the resolved path when
/// it may.
///
/// Asymmetric with [`writable_path`], and the asymmetry is the point:
///
/// * a description edit requires the path to *exist* and to be a `.gdl` file,
///   because that method rewrites a file the operator already has;
/// * generation *creates* files that are not `.gdl`, so a missing path is
///   allowed -- the nearest existing ancestor is what gets checked -- and the
///   path must **not** sit inside a source root. Writing generated Rust next
///   to human-authored Rust is ADR-0010 tier 5.
///
/// The workspace is still required. Failing closed: if nothing was declared,
/// nothing is writable.
fn writable_out_root(state: &State, path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("cannot resolve working directory: {e}"))?
            .join(path)
    };

    let existing = nearest_existing(&absolute)?;
    let canonical_existing = existing
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize `{}`: {e}", existing.display()))?;

    // **Source roots before the workspace, and this order is the whole point.**
    // A source root may sit *beside* the workspace -- the corpus is a sibling of
    // this repository, and `products/payments-demo` names `../../../gears-rust`
    // -- so generating into one is both "outside the declared workspace" and
    // "inside a source root". Both are refusals; only the second names the rule
    // (ADR-0010 tier 5, do not write next to human-authored crates) instead of
    // describing a boundary nobody meant to cross.
    //
    // The loop below the lexical join used to be the only one, under a comment
    // claiming exactly this precedence -- which the workspace check above it made
    // unreachable for the one layout the comment named. Checked here against the
    // nearest *existing* ancestor, because the joined path does not exist yet at
    // this point and cannot: the join needs the workspace this check precedes.
    if let Some(refusal) = inside_a_source_root(state, &canonical_existing, path) {
        return Err(refusal);
    }

    let Some(raw_workspace) = state.workspace.as_ref() else {
        return Err("no workspace was declared, so no output root is writable".to_owned());
    };
    let workspace = raw_workspace.canonicalize().map_err(|e| {
        format!(
            "cannot canonicalize workspace `{}`: {e}",
            raw_workspace.display()
        )
    })?;
    if !canonical_existing.starts_with(&workspace) {
        return Err(format!(
            "`{}` is outside the declared workspace",
            path.display()
        ));
    }

    // Rebuild the full path under the canonical ancestor so `starts_with`
    // compares like-for-like. The suffix is the components that do not exist
    // yet -- the ones generation is about to create. Joining them raw would
    // let `missing/../../../outside` pass `starts_with` and then
    // `create_dir_all` walk out of the workspace; each `..` is applied
    // against the ancestor and refused if it would leave the workspace.
    let suffix = absolute.strip_prefix(&existing).unwrap_or(Path::new(""));
    let resolved = join_lexically(&workspace, canonical_existing, suffix)
        .ok_or_else(|| format!("`{}` is outside the declared workspace", path.display()))?;

    // Again, on the joined path. The check above sees the nearest existing
    // ancestor; this one sees where the `..` components actually land, which is a
    // different question -- `workspace/keep/missing/../../../gears-rust` starts
    // inside the workspace and ends inside a source root.
    if let Some(refusal) = inside_a_source_root(state, &resolved, path) {
        return Err(refusal);
    }

    if !resolved.starts_with(&workspace) {
        return Err(format!(
            "`{}` is outside the declared workspace",
            path.display()
        ));
    }

    Ok(resolved)
}

/// The tier-5 refusal for `candidate`, or `None` when it is not in a source root.
///
/// One function because `writable_out_root` asks twice, about two different
/// paths: the nearest existing ancestor (before the workspace is known, so that a
/// source root beside the workspace gets the specific refusal) and the joined
/// path (after, so that a `..` chain landing in a root is caught too). Two copies
/// of the sentence would be two chances for them to drift, and the sentence is
/// what a person reads.
///
/// A root that cannot be canonicalized is skipped rather than refused: it is
/// already reported as a `FailedRoot` at `initialize`, and refusing every write
/// because an unrelated root went missing would be a second, worse answer to
/// that.
fn inside_a_source_root(state: &State, candidate: &Path, requested: &Path) -> Option<String> {
    state.roots.iter().find_map(|root| {
        let src = root.root.canonicalize().ok()?;
        candidate.starts_with(&src).then(|| {
            format!(
                "`{}` is inside a source root; generation must not write next to \
                 human-authored crates",
                requested.display()
            )
        })
    })
}

/// Join `suffix` onto `ancestor` without letting `..` leave `workspace`.
///
/// `Path::join` keeps `..` as a component, so a later `starts_with` on the
/// unresolved path is not a containment check. `normalize_lexically` is
/// unstable on the toolchain this crate builds with, so the walk is done here.
fn join_lexically(workspace: &Path, ancestor: PathBuf, suffix: &Path) -> Option<PathBuf> {
    let mut resolved = ancestor;
    for component in suffix.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => resolved.push(part),
            Component::ParentDir => {
                if !resolved.pop() || !resolved.starts_with(workspace) {
                    return None;
                }
            }
            Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    Some(resolved)
}

/// The lock at `path` against the one just resolved.
///
/// `None` only when there is no file. Everything else is an answer worth showing:
/// a file that will not parse is reported as unreadable rather than as an empty
/// diff, because "there is something there and it is not a lock" is neither
/// current nor stale.
///
/// The difference is `LockDiff::summary()`, which is *structured* comparison of
/// two parsed locks rather than a text diff -- so it says "this binding changed"
/// instead of "line 214 differs". Its own doc comment names this widget as the
/// consumer, which is why the client is sent the sentences instead of computing
/// them: a second implementation of "what changed" would be a second answer, and
/// a lock exists to have one.
fn compare_to_disk(path: &Path, resolved: &ResolvedProduct) -> Option<LockOnDisk> {
    let canonical = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            return Some(LockOnDisk {
                canonical: String::new(),
                lock_hash: String::new(),
                changes: Vec::new(),
                unreadable: Some(e.to_string()),
            });
        }
    };
    match gearbox_lock::read(&canonical) {
        Ok(on_disk) => {
            let diff = gearbox_lock::diff(&on_disk, resolved);
            Some(LockOnDisk {
                canonical,
                lock_hash: on_disk.product.lock_hash,
                changes: diff.summary(),
                unreadable: None,
            })
        }
        Err(e) => Some(LockOnDisk {
            canonical,
            lock_hash: String::new(),
            changes: Vec::new(),
            unreadable: Some(e.to_string()),
        }),
    }
}

/// Where a product's generated tree lives: `out` if the caller named one, else
/// `.gearbox/<product>/<profile>/` under the declared workspace.
///
/// One function because two things need the same answer -- generation writes the
/// tree and `product/lock` compares against the lock inside it -- and a lock
/// compared against a different directory than the one generation writes would be
/// a diff nobody could act on.
///
/// `None` means no workspace was declared and no `out` was given, so there is no
/// default to compute.
fn default_out_root(state: &State, out: Option<&str>, resolved: &Resolved) -> Option<PathBuf> {
    if let Some(path) = out {
        return Some(PathBuf::from(path));
    }
    Some(
        state
            .workspace
            .as_ref()?
            .join(".gearbox")
            .join(&resolved.product.product.id)
            .join(resolved.profile.as_str()),
    )
}

/// The nearest ancestor of `path` that exists, including `path` itself.
fn nearest_existing(path: &Path) -> Result<PathBuf, String> {
    let mut cursor = path.to_path_buf();
    loop {
        if cursor.exists() {
            return Ok(cursor);
        }
        match cursor.parent() {
            Some(parent) => cursor = parent.to_path_buf(),
            None => {
                return Err(format!("`{}` has no existing ancestor", path.display()));
            }
        }
    }
}

/// Everything generation needs after the two gates (resolution is writable,
/// output root is allowed). Shared by plan, apply and file so they cannot
/// answer about different trees of the same request.
struct PreparedGenerate {
    files: gearbox_ir::FileSet,
    out_root: PathBuf,
    base_root: PathBuf,
    diagnostics: Vec<Diagnostic>,
    /// Keys whose builtin the product replaced.
    ///
    /// The CLI has always printed this and the RPC path dropped it, so a chart
    /// that came out looking wrong had a visible cause in one client and none in
    /// the other. An unexpected Dockerfile should say who wrote it.
    overridden_templates: Vec<String>,
}

fn prepare_generate(
    state: &mut State,
    id: &RequestId,
    path: &str,
    profile: Option<&str>,
    out: Option<&str>,
) -> Result<PreparedGenerate, Response> {
    let resolved = resolve_once(state, id, path, profile, None)?;
    if !resolved.product.is_writable() {
        return Err(error_with_diagnostics(
            id.clone(),
            error_code::GENERATE_REFUSED,
            "resolution reported errors; nothing was generated",
            &resolved.diagnostics,
        ));
    }

    let Some(requested) = default_out_root(state, out, &resolved) else {
        return Err(error(
            id.clone(),
            error_code::GENERATE_REFUSED,
            "no workspace was declared, so there is no default output root",
        ));
    };
    let out_root = match writable_out_root(state, &requested) {
        Ok(root) => root,
        Err(refusal) => {
            return Err(error(id.clone(), error_code::GENERATE_REFUSED, &refusal));
        }
    };

    let source_roots: BTreeMap<_, _> = state
        .roots
        .iter()
        .map(|root| (root.id.clone(), root.root.clone()))
        .collect();
    let templates = match gearbox_engine::TemplateSet::load_for_product(
        Path::new(path),
        resolved.templates.as_deref(),
    ) {
        Ok(templates) => templates,
        Err(e) => {
            return Err(error(
                id.clone(),
                error_code::GENERATE_REFUSED,
                &format!("could not load template overrides: {e}"),
            ));
        }
    };
    let generated = match gearbox_engine::generate(&gearbox_engine::generate::GenerateInput {
        lock: &resolved.product,
        source_roots: &source_roots,
        out_root: &out_root,
        templates,
        product_dir: Path::new(path).parent(),
        catalogue: state.catalogue.as_ref(),
    }) {
        Ok(generated) => generated,
        Err(e) => {
            return Err(error(
                id.clone(),
                error_code::GENERATE_REFUSED,
                &format!("generation failed: {e}"),
            ));
        }
    };

    let base_root = gearbox_engine::generate::base_root_for(&out_root);
    let mut diagnostics = resolved.diagnostics;
    // See `Generated::diagnostics`: computing this and dropping it is exactly
    // what made a house template invisible in Studio for a milestone.
    diagnostics.extend(generated.diagnostics.as_slice().iter().cloned());

    Ok(PreparedGenerate {
        files: generated.files,
        out_root,
        base_root,
        diagnostics,
        overridden_templates: generated.overridden_templates,
    })
}

fn dispatch_generate(state: &mut State, request: Request) -> Response {
    let id = request.id.clone();
    if let Some(refusal) = require_ready(state, &id) {
        return refusal;
    }
    match request.method.as_str() {
        method::GENERATE_PLAN => match cast::<GenerateParams>(request) {
            Ok((id, params)) => generate_plan(state, id, &params),
            Err(e) => invalid_params(id, &e),
        },
        method::GENERATE_APPLY => match cast::<GenerateParams>(request) {
            Ok((id, params)) => generate_apply(state, id, &params),
            Err(e) => invalid_params(id, &e),
        },
        method::GENERATE_FILE => match cast::<GenerateFileParams>(request) {
            Ok((id, params)) => generate_file(state, id, &params),
            Err(e) => invalid_params(id, &e),
        },
        other => error(
            id,
            lsp_server::ErrorCode::MethodNotFound as i32,
            &format!("unknown method `{other}`"),
        ),
    }
}

fn generate_plan(state: &mut State, id: RequestId, params: &GenerateParams) -> Response {
    let prepared = match prepare_generate(
        state,
        &id,
        &params.path,
        params.profile.as_deref(),
        params.out.as_deref(),
    ) {
        Ok(prepared) => prepared,
        Err(refusal) => return refusal,
    };

    match gearbox_engine::generate::plan(&prepared.files, &prepared.out_root, &prepared.base_root) {
        Ok((plans, apply_diagnostics)) => {
            let mut diagnostics = prepared.diagnostics;
            diagnostics.extend(apply_diagnostics.as_slice().iter().cloned());
            ok(
                id,
                &GeneratePlanResult {
                    plans,
                    diagnostics,
                    out_root: prepared.out_root.display().to_string(),
                    overridden_templates: prepared.overridden_templates,
                },
            )
        }
        Err(e) => error(
            id,
            error_code::GENERATE_REFUSED,
            &format!("cannot plan generation: {e}"),
        ),
    }
}

fn generate_apply(state: &mut State, id: RequestId, params: &GenerateParams) -> Response {
    if !state.allow_writes {
        return error(
            id,
            error_code::WRITES_NOT_ALLOWED,
            "this session declared no write capability, so nothing will be written; \
             pass `allow_writes: true` to `initialize` if the client is meant to write files",
        );
    }

    let prepared = match prepare_generate(
        state,
        &id,
        &params.path,
        params.profile.as_deref(),
        params.out.as_deref(),
    ) {
        Ok(prepared) => prepared,
        Err(refusal) => return refusal,
    };

    match gearbox_engine::apply_generate(&prepared.files, &prepared.out_root, &prepared.base_root) {
        Ok(outcome) => {
            let mut diagnostics = prepared.diagnostics;
            diagnostics.extend(outcome.diagnostics.as_slice().iter().cloned());
            ok(
                id,
                &GenerateApplyResult {
                    plans: outcome.plans,
                    diagnostics,
                    written: u32::try_from(outcome.written).unwrap_or(u32::MAX),
                    overridden_templates: prepared.overridden_templates,
                },
            )
        }
        Err(e) => error(
            id,
            error_code::GENERATE_REFUSED,
            &format!("cannot apply generation: {e}"),
        ),
    }
}

fn generate_file(state: &mut State, id: RequestId, params: &GenerateFileParams) -> Response {
    let file = match RelPath::new(&params.file) {
        Ok(file) => file,
        Err(e) => {
            return error(
                id,
                error_code::GENERATE_REFUSED,
                &format!("`{}` is not a usable generated path: {e}", params.file),
            );
        }
    };

    let prepared = match prepare_generate(
        state,
        &id,
        &params.path,
        params.profile.as_deref(),
        params.out.as_deref(),
    ) {
        Ok(prepared) => prepared,
        Err(refusal) => return refusal,
    };

    let Some(entry) = prepared.files.get(&file) else {
        return error(
            id,
            error_code::GENERATE_REFUSED,
            &format!("`{}` is not in the generated set", params.file),
        );
    };

    let (plans, _) = match gearbox_engine::generate::plan(
        &prepared.files,
        &prepared.out_root,
        &prepared.base_root,
    ) {
        Ok(planned) => planned,
        Err(e) => {
            return error(
                id,
                error_code::GENERATE_REFUSED,
                &format!("cannot plan generation: {e}"),
            );
        }
    };
    let Some(plan) = plans.iter().find(|p| p.path == file) else {
        return error(
            id,
            error_code::GENERATE_REFUSED,
            &format!("`{}` is not in the generated set", params.file),
        );
    };

    let on_disk = prepared.out_root.join(file.as_str());
    let current = match std::fs::read(&on_disk) {
        Ok(bytes) => std::str::from_utf8(&bytes).ok().map(str::to_owned),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return error(
                id,
                error_code::GENERATE_REFUSED,
                &format!("cannot read `{}`: {e}", on_disk.display()),
            );
        }
    };

    ok(
        id,
        &GenerateFileResult {
            proposed: entry.as_text().map(str::to_owned),
            current,
            action: plan.action,
            ownership: plan.ownership,
        },
    )
}

/// Replace a file's contents without ever leaving it half-written.
///
/// Temp file in the same directory, then rename: a rename within one filesystem
/// is atomic, so a crash leaves either the old description or the new one and
/// never a truncated one. The same directory matters -- across filesystems a
/// rename is a copy, and the guarantee is gone.
fn is_semver(value: &str) -> bool {
    let mut parts = value.split('.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && [major, minor, patch]
            .into_iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

fn toml_basic_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn write_atomically(path: &Path, contents: &str) -> std::io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    let temporary = directory.join(format!(
        ".{}.gearbox-tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("product.gdl")
    ));
    std::fs::write(&temporary, contents)?;
    std::fs::rename(&temporary, path)
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
fn catalogue_load(connection: &Connection, state: &mut State, id: RequestId) -> Option<Response> {
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

    let diagnostics = scan.catalogue.diagnostics.as_slice().to_vec();
    // The whole point of the cache, and it was never being filled.
    //
    // A staged load parses every gear crate in the tree -- it is the most
    // expensive thing the server does. Dropping the result on the floor meant
    // the first `product/resolve` after a load called `catalogue_for`, found
    // `None`, and did the entire scan again *non-staged*: the same seconds of
    // work, this time with no progress notifications and with the request thread
    // blocked, for a catalogue the client already had on screen.
    state.catalogue = Some(scan.catalogue);

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
            diagnostics,
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
        &e.to_string(),
    )
}
