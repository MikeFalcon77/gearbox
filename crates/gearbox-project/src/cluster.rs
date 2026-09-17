//! Projecting cluster providers and their capabilities out of Rust.
//!
//! Three hops, because the facts live in three places and no single one of them
//! has the whole answer:
//!
//! 1. `ClusterGear::provider_registry()` says *which* provider types are
//!    registered, and for which primitive. It names types, not names.
//! 2. The provider's own `impl Cluster*Provider` says what the provider is
//!    *called* -- via `fn provider()`, which returns a `PROVIDER_NAME` const.
//! 3. The *backend* impl says what the provider can *do*. This is the hop that
//!    is easy to get wrong: the provider traits carry no capability at all, only
//!    `provider()` and a `build_*` factory. `consistency()` and `features()`
//!    live on `ClusterCacheBackend` / `DistributedLockBackend` /
//!    `LeaderElectionBackend`, which the factory returns behind an `Arc<dyn _>`.
//!
//! Hop 3 cannot follow the value flow (provider -> builder -> handle -> trait
//! object) with `syn` alone. It does not need to: within one plugin crate there
//! is exactly one impl of each backend trait, so the impl is locatable by trait
//! and the ambiguous case is reported rather than guessed
//! ([`ClusterProjectionError::BackendAmbiguous`]).
//!
//! Note what is deliberately *not* here. `process_local` and `needs_credentials`
//! have no Rust representation -- the nearest signal is that one plugin's
//! options carry a connection string and the other's do not, and reading
//! "needs credentials" out of that is our inference, not the code's statement.
//! They stay declared in GDL.

use std::collections::BTreeSet;

use gearbox_ir::{CapabilityId, ClusterPrimitive, IdError, capabilities};

use crate::scan::RustFile;

/// Why a cluster fact could not be projected.
#[derive(Debug, thiserror::Error)]
pub enum ClusterProjectionError {
    #[error("no `impl {trait_name}` found in {scanned}")]
    BackendNotFound {
        trait_name: &'static str,
        scanned: String,
    },

    #[error("{scanned} has {} impls of `{trait_name}`: {}", .candidates.len(), .candidates.join(", "))]
    BackendAmbiguous {
        trait_name: &'static str,
        scanned: String,
        /// The implementing type names, so the message names the choice.
        candidates: Vec<String>,
    },

    #[error("cannot read the provider name for `{provider_type}`: {reason}")]
    ProviderName {
        provider_type: String,
        reason: String,
    },

    #[error("cannot read `{method}` on `{ty}`: {reason}")]
    Capability {
        method: &'static str,
        ty: String,
        reason: String,
    },

    /// A `with_*_provider` whose argument is not a readable provider path.
    ///
    /// Typed rather than a bare `String`, which is what this used to be: the
    /// caller could only interpolate a sentence, so this case could not be told
    /// apart from anything added to the projection later.
    #[error("`{setter}(..)` registers a {primitive} provider, but its argument {reason}")]
    ProviderRegistration {
        setter: String,
        primitive: &'static str,
        reason: String,
    },

    /// Several impls carry a `provider_registry` method.
    ///
    /// Refused for the reason [`Self::BackendAmbiguous`] is: the cluster crate
    /// holds SDK defaults plus test doubles, and merging two registries into one
    /// list loses the fact that there were two. Hop 1 used to accept silently
    /// what hop 3 reports as a caller error.
    #[error("{scanned} has {} impls with a `provider_registry` method: {}", .candidates.len(), .candidates.join(", "))]
    RegistryAmbiguous {
        scanned: String,
        candidates: Vec<String>,
    },

    /// `backend = "..."` is absolute or climbs out of the crate.
    ///
    /// Its own variant, mirroring `LocateError::AttrEscapes`. It used to be
    /// reported as [`Self::Capability`] with the path stuffed into `ty`, so the
    /// message read "cannot read `features` on `<a path>`" and a caller matching
    /// on `Capability` saw a path mistake.
    #[error("`backend = \"{0}\"` is absolute or climbs out of the crate")]
    BackendEscapes(String),

    #[error(transparent)]
    Id(#[from] IdError),
}

/// One `with_*_provider(...)` registration, as `provider_registry()` writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedClusterProvider {
    /// Which `with_*_provider` call registered it.
    pub primitive: ClusterPrimitive,
    /// The plugin crate's library identifier, from the path's first segment.
    /// Empty when the type was named without a crate qualifier.
    pub plugin_lib: String,
    /// The provider type's own name, e.g. `StandaloneCacheProvider`.
    pub provider_type: String,
}

/// How an SDK-default backend arrives at its capability.
///
/// The default leader-election and lock backends do not *declare* a capability;
/// they compute it from the cache they sit on
/// (`LockFeatures::new(self.cache.consistency() == ...Linearizable)`). Recording
/// the rule rather than today's answer is what keeps this honest when a third
/// cache backend lands: the answer changes, the rule does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkDefaultRule {
    pub primitive: ClusterPrimitive,
    /// True when the backend is linearizable exactly if its cache is.
    pub linearizable_from_cache: bool,
}

/// The backend trait that carries `primitive`'s capabilities.
const fn backend_trait(primitive: ClusterPrimitive) -> &'static str {
    match primitive {
        ClusterPrimitive::Cache => "ClusterCacheBackend",
        ClusterPrimitive::LeaderElection => "LeaderElectionBackend",
        ClusterPrimitive::Lock => "DistributedLockBackend",
    }
}

/// The primitive a `with_*_provider` setter registers, if it is one.
fn primitive_for_setter(method: &str) -> Option<ClusterPrimitive> {
    match method {
        "with_cache_provider" => Some(ClusterPrimitive::Cache),
        "with_leader_election_provider" => Some(ClusterPrimitive::LeaderElection),
        "with_lock_provider" => Some(ClusterPrimitive::Lock),
        _ => None,
    }
}

fn last_segment(path: &syn::Path) -> String {
    path.segments
        .last()
        .map(|s| s.ident.to_string())
        .unwrap_or_default()
}

/// A block's trailing expression -- the value a `fn` with no `return` yields.
fn tail_expr(block: &syn::Block) -> Option<&syn::Expr> {
    match block.stmts.last()? {
        syn::Stmt::Expr(expr, None) => Some(expr),
        _ => None,
    }
}

/// Every `impl` in `files`, paired with the file that holds it.
fn impls(files: &[RustFile]) -> impl Iterator<Item = (&RustFile, &syn::ItemImpl)> {
    files.iter().flat_map(|file| {
        file.ast.items.iter().filter_map(move |item| match item {
            syn::Item::Impl(imp) => Some((file, imp)),
            _ => None,
        })
    })
}

/// Whether `imp` implements the trait named `trait_name`.
fn implements(imp: &syn::ItemImpl, trait_name: &str) -> bool {
    imp.trait_
        .as_ref()
        .is_some_and(|(_, path, _)| last_segment(path) == trait_name)
}

/// The named method in an impl block.
fn method<'a>(imp: &'a syn::ItemImpl, name: &str) -> Option<&'a syn::ImplItemFn> {
    imp.items.iter().find_map(|item| match item {
        syn::ImplItem::Fn(f) if f.sig.ident == name => Some(f),
        _ => None,
    })
}

/// Unwrap `Arc::new(x)`, `Box::new(x)` or a bare `x` down to a path.
fn wrapped_path(expr: &syn::Expr) -> Option<&syn::Path> {
    match expr {
        syn::Expr::Path(p) => Some(&p.path),
        // `Arc::new(<inner>)` -- one argument, itself a path.
        syn::Expr::Call(call) => {
            let is_new =
                matches!(&*call.func, syn::Expr::Path(p) if last_segment(&p.path) == "new");
            if !is_new || call.args.len() != 1 {
                return None;
            }
            wrapped_path(call.args.first()?)
        }
        _ => None,
    }
}

/// Collect `.with_*_provider(...)` calls from a builder chain, in source order.
///
/// `A.with_a(x).with_b(y)` nests as `MethodCall { receiver: MethodCall { .. } }`,
/// so descending into the receiver before recording yields source order without
/// a reversal step.
///
/// A `with_*_provider` whose argument is not a readable path is an error, not a
/// skip. The caller is documented to treat a short list as a projection failure,
/// and it cannot: a chain of three registrations where the middle one is
/// unreadable yields two, which looks exactly like a chain of two.
fn walk_chain(
    expr: &syn::Expr,
    out: &mut Vec<ProjectedClusterProvider>,
) -> Result<(), ClusterProjectionError> {
    let syn::Expr::MethodCall(call) = expr else {
        return Ok(());
    };
    walk_chain(&call.receiver, out)?;

    let setter = call.method.to_string();
    let Some(primitive) = primitive_for_setter(&setter) else {
        return Ok(());
    };
    let unreadable = |what: &str| {
        Err(ClusterProjectionError::ProviderRegistration {
            setter: setter.clone(),
            primitive: primitive.slug(),
            reason: what.to_owned(),
        })
    };

    let Some(path) = call.args.first().and_then(wrapped_path) else {
        return unreadable("is not a path, `Arc::new(<path>)` or `Box::new(<path>)`");
    };

    let segments: Vec<String> = path.segments.iter().map(|s| s.ident.to_string()).collect();
    let (plugin_lib, provider_type) = match segments.as_slice() {
        [] => return unreadable("is an empty path"),
        [only] => (String::new(), only.clone()),
        [first, .., last] => (first.clone(), last.clone()),
    };

    out.push(ProjectedClusterProvider {
        primitive,
        plugin_lib,
        provider_type,
    });
    Ok(())
}

/// Project the `with_*_provider` registrations from `ClusterGear::provider_registry()`.
///
/// Returns them in source order. An empty `Ok` means the function was not found
/// or its body is not a builder chain -- both of which the caller should treat
/// as a projection failure rather than "no providers", since the cluster gear
/// always registers at least one.
///
/// # Errors
/// Returns [`ClusterProjectionError::ProviderRegistration`] for the first
/// `with_*_provider` argument that cannot be read as a provider path, and
/// [`ClusterProjectionError::RegistryAmbiguous`] when more than one impl in
/// `files` carries a `provider_registry` method.
pub fn project_provider_registry(
    files: &[RustFile],
    scanned: &str,
) -> Result<Vec<ProjectedClusterProvider>, ClusterProjectionError> {
    let found: Vec<&syn::ItemImpl> = impls(files)
        .filter(|(_, imp)| method(imp, "provider_registry").is_some())
        .map(|(_, imp)| imp)
        .collect();

    let imp = match found.as_slice() {
        [] => return Ok(Vec::new()),
        [only] => *only,
        many => {
            let mut candidates: Vec<String> = many
                .iter()
                .map(|imp| match &*imp.self_ty {
                    syn::Type::Path(p) => last_segment(&p.path),
                    _ => "<non-path type>".to_owned(),
                })
                .collect();
            candidates.sort();
            return Err(ClusterProjectionError::RegistryAmbiguous {
                scanned: scanned.to_owned(),
                candidates,
            });
        }
    };

    let mut out = Vec::new();
    if let Some(func) = method(imp, "provider_registry")
        && let Some(expr) = tail_expr(&func.block)
    {
        walk_chain(expr, &mut out)?;
    }
    Ok(out)
}

/// Resolve a `const NAME: &str = "..."` anywhere in `files`.
pub(crate) fn resolve_str_const(files: &[RustFile], ident: &str) -> Option<String> {
    files.iter().find_map(|file| {
        file.ast.items.iter().find_map(|item| match item {
            syn::Item::Const(c) if c.ident == ident => match &*c.expr {
                syn::Expr::Lit(syn::ExprLit {
                    lit: syn::Lit::Str(s),
                    ..
                }) => Some(s.value()),
                _ => None,
            },
            _ => None,
        })
    })
}

/// Project the name a provider answers to in operator configuration.
///
/// Reads `fn provider()` on the provider's own trait impl. Accepts a string
/// literal or a path to a `&str` const in the same crate; both plugins use the
/// const form (`PROVIDER_NAME`). Anything else is reported, because a provider
/// whose name cannot be read would otherwise silently drop out of the catalogue.
///
/// # Errors
/// Returns [`ClusterProjectionError::ProviderName`] when no matching impl
/// exists, `provider()` is absent, or its body is neither of the two accepted
/// shapes.
pub fn project_provider_name(
    files: &[RustFile],
    provider_type: &str,
) -> Result<String, ClusterProjectionError> {
    let fail = |reason: String| ClusterProjectionError::ProviderName {
        provider_type: provider_type.to_owned(),
        reason,
    };

    let func = impls(files)
        .filter(|(_, imp)| {
            let is_provider_trait = imp.trait_.as_ref().is_some_and(|(_, path, _)| {
                let name = last_segment(path);
                name.starts_with("Cluster") && name.ends_with("Provider")
            });
            let is_target = matches!(&*imp.self_ty, syn::Type::Path(p)
                if last_segment(&p.path) == provider_type);
            is_provider_trait && is_target
        })
        .find_map(|(_, imp)| method(imp, "provider"))
        .ok_or_else(|| fail("no `impl Cluster*Provider` with a `provider()` method".to_owned()))?;

    let expr = tail_expr(&func.block)
        .ok_or_else(|| fail("`provider()` has no trailing expression".to_owned()))?;

    match expr {
        syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Str(s),
            ..
        }) => Ok(s.value()),
        syn::Expr::Path(p) => {
            let ident = last_segment(&p.path);
            resolve_str_const(files, &ident).ok_or_else(|| {
                fail(format!(
                    "`provider()` returns `{ident}`, which is not a `&str` const in this crate"
                ))
            })
        }
        _ => Err(fail(
            "`provider()` returns neither a string literal nor a const path".to_owned(),
        )),
    }
}

/// Read the single `bool` literal argument of a `*Features::new(..)` call.
///
/// The feature structs are `#[non_exhaustive]` with a positional constructor, so
/// a new flag changes the arity. That must be an error rather than a defaulted
/// `false`: silently reading the wrong flag is worse than refusing to read.
fn features_flag(expr: &syn::Expr, ty: &str) -> Result<Option<bool>, ClusterProjectionError> {
    let fail = |reason: String| ClusterProjectionError::Capability {
        method: "features",
        ty: ty.to_owned(),
        reason,
    };

    let syn::Expr::Call(call) = expr else {
        return Err(fail("body is not a `*Features::new(..)` call".to_owned()));
    };
    if call.args.len() != 1 {
        return Err(fail(format!(
            "`*Features::new` takes {} arguments here; this parser models exactly 1, \
             so a flag was added and the projection must be updated",
            call.args.len()
        )));
    }
    match call.args.first() {
        Some(syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Bool(b),
            ..
        })) => Ok(Some(b.value)),
        // The SDK-default derivation, pointed at by the wrong projector. Still an
        // error: this shape *has* a readable meaning, and reading it here would
        // attribute the default's capability to a plugin backend.
        Some(arg) if is_cache_consistency_check(arg) => Err(fail(
            "argument is not a `bool` literal (a computed flag belongs to \
             `project_sdk_defaults`, not a plugin backend)"
                .to_owned(),
        )),
        // Anything else computed: the backend decides the flag at run time, from
        // what it connected to. `None`, not an error -- see
        // [`BackendCapabilities`] for why those are different failures.
        _ => Ok(None),
    }
}

/// What a backend's capability methods yielded.
///
/// **Two failures live here that used to be one.** A capability method the
/// parser cannot make sense of is an error -- the feature structs are
/// `#[non_exhaustive]` with positional constructors, so a flag added upstream
/// changes the arity, and reading the wrong flag would claim a capability the
/// backend does not have. That stays [`ClusterProjectionError::Capability`].
///
/// A method whose value the backend *computes* is a different thing. The redis
/// cache decides its consistency from the topology it finds at connect time
/// (`redis_cluster_plugin`'s `consistency()` returns a field its preflight set),
/// so there is no composition-time fact to read -- and refusing the whole
/// provider over it made a configurable backend unusable. Those methods are
/// named in [`Self::runtime_determined`] and simply contribute no capability,
/// which `ClusterProviderDecl::satisfies` already reads correctly: the provider
/// answers its primitives and satisfies only an empty requirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendCapabilities {
    /// The capabilities the backend states in Rust.
    pub declared: BTreeSet<CapabilityId>,

    /// The backend type the capabilities were read from, for diagnostics.
    pub ty: String,

    /// Capability methods whose value is decided at run time, by method name.
    pub runtime_determined: Vec<&'static str>,
}

/// Project the capabilities `primitive`'s backend declares, from the unique
/// `impl` of that backend trait in `files`.
///
/// `files` must be one plugin crate's `src/`. The cluster crate itself holds
/// several impls of these traits (the SDK defaults plus test doubles), so
/// pointing this at the cluster crate is a caller error that surfaces as
/// [`ClusterProjectionError::BackendAmbiguous`] rather than a wrong answer.
///
/// # Errors
/// Returns [`ClusterProjectionError`] when the impl is absent or not unique, or
/// when `consistency()`/`features()` cannot be read.
pub fn project_backend_capabilities(
    files: &[RustFile],
    primitive: ClusterPrimitive,
    scanned: &str,
    narrow: Option<&str>,
) -> Result<BackendCapabilities, ClusterProjectionError> {
    let trait_name = backend_trait(primitive);

    // `backend = "src/cache.rs"` narrows to one file, exactly as `attr` narrows
    // the gear attribute. This is what resolves an ambiguity report, so the help
    // text that suggests it has to actually work.
    let narrowed = match narrow {
        Some(spec) => Some(
            crate::scan::narrowing_path(spec).map_err(ClusterProjectionError::BackendEscapes)?,
        ),
        None => None,
    };

    let found: Vec<&syn::ItemImpl> = impls(files)
        .filter(|(file, _)| narrowed.as_ref().is_none_or(|want| &file.relative == want))
        .filter(|(_, imp)| implements(imp, trait_name))
        .map(|(_, imp)| imp)
        .collect();

    let imp = match found.as_slice() {
        [] => {
            return Err(ClusterProjectionError::BackendNotFound {
                trait_name,
                scanned: scanned.to_owned(),
            });
        }
        [only] => *only,
        many => {
            let mut candidates: Vec<String> = many
                .iter()
                .map(|imp| match &*imp.self_ty {
                    syn::Type::Path(p) => last_segment(&p.path),
                    _ => "<non-path type>".to_owned(),
                })
                .collect();
            candidates.sort();
            return Err(ClusterProjectionError::BackendAmbiguous {
                trait_name,
                scanned: scanned.to_owned(),
                candidates,
            });
        }
    };

    let ty = match &*imp.self_ty {
        syn::Type::Path(p) => last_segment(&p.path),
        _ => "<non-path type>".to_owned(),
    };

    let mut caps = BTreeSet::new();
    let mut runtime_determined: Vec<&'static str> = Vec::new();

    // The cache carries two axes: an enum for consistency, a bool for watch.
    // The other two carry only `linearizable`, and via `features()`.
    if primitive == ClusterPrimitive::Cache {
        let func =
            method(imp, "consistency").ok_or_else(|| ClusterProjectionError::Capability {
                method: "consistency",
                ty: ty.clone(),
                reason: "method is absent".to_owned(),
            })?;
        let expr = tail_expr(&func.block).ok_or_else(|| ClusterProjectionError::Capability {
            method: "consistency",
            ty: ty.clone(),
            reason: "no trailing expression".to_owned(),
        })?;
        // A path is a declaration and can be read. Anything else -- a field, a
        // call -- is the backend computing its consistency from the server it
        // connected to, which is not a fact this projection can carry.
        if let syn::Expr::Path(p) = expr {
            if last_segment(&p.path) == "Linearizable" {
                caps.insert(CapabilityId::new(capabilities::CACHE_LINEARIZABLE)?);
            }
        } else {
            runtime_determined.push("consistency");
        }
    }

    let func = method(imp, "features").ok_or_else(|| ClusterProjectionError::Capability {
        method: "features",
        ty: ty.clone(),
        reason: "method is absent".to_owned(),
    })?;
    let expr = tail_expr(&func.block).ok_or_else(|| ClusterProjectionError::Capability {
        method: "features",
        ty: ty.clone(),
        reason: "no trailing expression".to_owned(),
    })?;
    match features_flag(expr, &ty)? {
        Some(true) => {
            caps.insert(CapabilityId::new(match primitive {
                ClusterPrimitive::Cache => capabilities::CACHE_PREFIX_WATCH,
                ClusterPrimitive::LeaderElection => capabilities::LEADER_ELECTION_LINEARIZABLE,
                ClusterPrimitive::Lock => capabilities::LOCK_LINEARIZABLE,
            })?);
        }
        Some(false) => {}
        None => runtime_determined.push("features"),
    }

    Ok(BackendCapabilities {
        declared: caps,
        ty,
        runtime_determined,
    })
}

/// Whether an expression is the `self.cache.consistency() == ..::Linearizable`
/// comparison the SDK defaults use to derive their capability.
fn is_cache_consistency_check(expr: &syn::Expr) -> bool {
    let syn::Expr::Binary(bin) = expr else {
        return false;
    };
    if !matches!(bin.op, syn::BinOp::Eq(_)) {
        return false;
    }
    let calls_consistency = matches!(&*bin.left, syn::Expr::MethodCall(c)
        if c.method == "consistency");
    let names_linearizable = matches!(&*bin.right, syn::Expr::Path(p)
        if last_segment(&p.path) == "Linearizable");
    calls_consistency && names_linearizable
}

/// Project the rule the SDK-default backends use, from the cluster crate.
///
/// Leader election and lock fall back to a compare-and-swap default layered over
/// the profile's cache whenever the operator binds no native provider. Those
/// defaults declare no fixed capability -- they inherit the cache's. This finds
/// which primitives work that way so the resolver can apply the rule per profile
/// instead of hard-coding today's answer.
#[must_use]
pub fn project_sdk_defaults(files: &[RustFile]) -> Vec<SdkDefaultRule> {
    let mut out = Vec::new();
    for primitive in [ClusterPrimitive::LeaderElection, ClusterPrimitive::Lock] {
        let trait_name = backend_trait(primitive);
        let derived = impls(files)
            .filter(|(_, imp)| implements(imp, trait_name))
            .filter_map(|(_, imp)| method(imp, "features"))
            .filter_map(|func| tail_expr(&func.block))
            .any(|expr| match expr {
                syn::Expr::Call(call) => {
                    call.args.len() == 1
                        && call.args.first().is_some_and(is_cache_consistency_check)
                }
                _ => false,
            });
        if derived {
            out.push(SdkDefaultRule {
                primitive,
                linearizable_from_cache: true,
            });
        }
    }
    out
}

#[cfg(test)]
#[path = "cluster_tests.rs"]
mod cluster_tests;
