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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_engine::{Continue, LoadEvent, SourceRoot, default_source_ids, load_catalogue_staged};
use gearbox_ir::{Diagnostic, ExplanationGraph, ProfileId, RelPath, ResolvedProduct, SourceId};
use lsp_server::{Connection, ExtractError, Message, Notification, Request, RequestId, Response};

use crate::protocol::{
    Capabilities, CatalogueChanged, CatalogueDiagnostics, CatalogueLoadResult, EditGearParams,
    EditGearResult, FailedRoot, GenerateApplyResult, GenerateFileParams, GenerateFileResult,
    GenerateParams, GeneratePlanResult, InitializeParams, InitializeResult, LockOnDisk, LockParams,
    LockResult, LogParams, ProductLoadParams, ProductLoadResult, ProgressParams, ResolveParams,
    ResolveResult, ResolvedRoot, ServerInfo, ValidateParams, ValidateResult, error_code, method,
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
/// One resolution, and everything two callers need from it.
struct Resolved {
    product: ResolvedProduct,
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
fn resolve_once(
    state: &mut State,
    id: &RequestId,
    path_str: &str,
    profile: Option<&str>,
) -> Result<Resolved, Response> {
    let path = PathBuf::from(path_str);
    let scan = gearbox_engine::product::load_product(&path, None);
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
    let explanation = gearbox_engine::resolve::product::explain(&resolution);

    // The product's own diagnostics are already inside it; the ones added here
    // are the description's, which resolution never sees.
    diagnostics.extend(resolution.diagnostics.as_slice().iter().cloned());
    Ok(Resolved {
        product,
        explanation,
        diagnostics,
        profile,
    })
}

fn resolve(state: &mut State, id: RequestId, params: &ResolveParams) -> Response {
    match resolve_once(state, &id, &params.path, params.profile.as_deref()) {
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
    let resolved = match resolve_once(state, &id, &params.path, params.profile.as_deref()) {
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

    let path = PathBuf::from(&params.path);
    if let Err(refusal) = writable_path(state, &path) {
        return error(id, error_code::EDIT_REFUSED, &refusal);
    }

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

    let uri = format!("file://{}", path.display());
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

/// Whether a path may be written, and why not when it may not.
///
/// `cpt-gearbox-fr-rpc-writes-opt-in` requires rejecting "any path outside the
/// declared workspace or source roots". A product description lives in neither a
/// gear source root nor nowhere -- it sits beside the products -- which is why the
/// client declares a workspace at `initialize` and this checks against both.
///
/// If nothing was declared, nothing is writable. Failing closed is the only
/// defensible default for a method that changes files.
fn writable_path(state: &State, path: &Path) -> Result<(), String> {
    let Ok(canonical) = path.canonicalize() else {
        return Err(format!("`{}` does not exist", path.display()));
    };
    if canonical.extension().and_then(|e| e.to_str()) != Some("gdl") {
        return Err(format!(
            "`{}` is not a `.gdl` description; this method edits descriptions only",
            path.display()
        ));
    }

    let mut allowed: Vec<PathBuf> = state
        .roots
        .iter()
        .filter_map(|root| root.root.canonicalize().ok())
        .collect();
    allowed.extend(state.workspace.as_ref().and_then(|w| w.canonicalize().ok()));

    if allowed.is_empty() {
        return Err(
            "no workspace and no source root were declared, so no path is writable".to_owned(),
        );
    }
    if allowed.iter().any(|root| canonical.starts_with(root)) {
        Ok(())
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

    // Rebuild the full path under the canonical ancestor so `starts_with`
    // compares like-for-like. The suffix is the components that do not exist
    // yet -- the ones generation is about to create.
    let suffix = absolute.strip_prefix(&existing).unwrap_or(Path::new(""));
    let resolved = if suffix.as_os_str().is_empty() {
        canonical_existing
    } else {
        canonical_existing.join(suffix)
    };

    // Source roots first: they may sit *beside* the workspace (the gears-rust
    // slice is a sibling of this repository), and "do not write next to human
    // Rust" is the more specific refusal when both apply.
    for root in &state.roots {
        if let Ok(src) = root.root.canonicalize()
            && resolved.starts_with(&src)
        {
            return Err(format!(
                "`{}` is inside a source root; generation must not write next to \
                 human-authored crates",
                path.display()
            ));
        }
    }

    let Some(workspace) = state.workspace.as_ref().and_then(|w| w.canonicalize().ok()) else {
        return Err("no workspace was declared, so no output root is writable".to_owned());
    };
    if !resolved.starts_with(&workspace) {
        return Err(format!(
            "`{}` is outside the declared workspace",
            path.display()
        ));
    }

    Ok(resolved)
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
    let canonical = std::fs::read_to_string(path).ok()?;
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
    skipped: Vec<String>,
}

fn prepare_generate(
    state: &mut State,
    id: &RequestId,
    path: &str,
    profile: Option<&str>,
    out: Option<&str>,
) -> Result<PreparedGenerate, Response> {
    let resolved = resolve_once(state, id, path, profile)?;
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
    let generated = match gearbox_engine::generate(&gearbox_engine::generate::GenerateInput {
        lock: &resolved.product,
        source_roots: &source_roots,
        out_root: &out_root,
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
    Ok(PreparedGenerate {
        files: generated.files,
        out_root,
        base_root,
        diagnostics: resolved.diagnostics,
        skipped: generated
            .skipped
            .iter()
            .map(gearbox_ir::ProcessId::to_string)
            .collect(),
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
                    skipped: prepared.skipped,
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
        &format!("{e:?}"),
    )
}
