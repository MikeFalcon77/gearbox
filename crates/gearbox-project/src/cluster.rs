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

    /// `provider_registry()` exists and its body is a shape this cannot read.
    ///
    /// Distinct from an empty `Ok`, which means the method is not there at all.
    /// Collapsing the two is what let a readable registry be reported as an
    /// empty one: the engine's help told the reader to check for a builder
    /// chain that was present the whole time, three statements away from where
    /// the projector stopped looking.
    #[error("`provider_registry()` cannot be read: {reason}")]
    RegistryUnreadable { reason: String },

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

/// Whether a registration is in every build, or only in some.
///
/// **Three states, because two would have to lie about one of them.** A
/// registration inside `#[cfg(feature = "k8s")]` exists only where that feature
/// is enabled -- the cluster crate's own comment says "a profile binding
/// `provider: k8s` requires a build with this feature" -- and a catalogue that
/// recorded it as unconditional would let a product bind a backend its build
/// will not contain. The third state is for a predicate this cannot reduce to
/// one feature: it must not collapse into `Always`, which would make "we could
/// not read it" indistinguishable from "there was nothing to read".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeatureGate {
    /// Registered in every build.
    Always,
    /// Registered only where this cargo feature is enabled.
    Feature(String),
    /// Gated by a predicate this projector cannot reduce to a single feature.
    ///
    /// Carries the `cfg(...)` as written, so a diagnostic can quote it.
    Unreadable(String),
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
    /// The build condition this registration sits under.
    pub gated_by: FeatureGate,
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
    gate: &FeatureGate,
    out: &mut Vec<ProjectedClusterProvider>,
) -> Result<(), ClusterProjectionError> {
    let syn::Expr::MethodCall(call) = expr else {
        return Ok(());
    };
    walk_chain(&call.receiver, gate, out)?;

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
        gated_by: gate.clone(),
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

    let Some(func) = method(imp, "provider_registry") else {
        return Ok(Vec::new());
    };
    read_registry_body(&func.block)
}

/// Read every registration a `provider_registry()` body makes.
///
/// **Two shapes, because the corpus writes two.** The original is a function
/// whose whole body is one builder chain. The second arrived with the native
/// Kubernetes plugin: a chain bound to a local, a `#[cfg(feature = "k8s")]`
/// block that reassigns the local with three more registrations, and the local
/// returned. Reading only the tail expression saw a bare identifier, found no
/// chain, and answered "no registrations" -- which the engine reports as
/// `GBX0509` against a corpus that is perfectly correct, and which took every
/// cluster provider out of the catalogue, not just the gated ones. Both shipped
/// products stopped resolving.
///
/// **An unreadable body is an error, not an empty list.** That was the other
/// half of the failure: "the body is a shape I cannot read" and "this registry
/// is empty" arrived as the same value, so the diagnostic told the reader to
/// check a chain that was there all along.
fn read_registry_body(
    block: &syn::Block,
) -> Result<Vec<ProjectedClusterProvider>, ClusterProjectionError> {
    let mut out = Vec::new();
    let Some(tail) = tail_expr(block) else {
        return Err(ClusterProjectionError::RegistryUnreadable {
            reason: "its body has no trailing expression, so nothing says what it returns"
                .to_owned(),
        });
    };

    // The original shape: the body *is* the chain.
    if matches!(tail, syn::Expr::MethodCall(_)) {
        walk_chain(tail, &FeatureGate::Always, &mut out)?;
        return Ok(out);
    }

    // The bound shape: the body returns a local that statements above built up.
    let Some(local) = bare_ident(tail) else {
        return Err(ClusterProjectionError::RegistryUnreadable {
            reason: "its trailing expression is neither a builder chain nor a local it built"
                .to_owned(),
        });
    };

    for stmt in &block.stmts {
        match stmt {
            // `let mut registry = ProviderRegistry::new().with_*(..);`
            syn::Stmt::Local(decl) if binds(&decl.pat, &local) => {
                if let Some(init) = &decl.init {
                    walk_chain(&init.expr, &FeatureGate::Always, &mut out)?;
                }
            }
            // A block, which is how a `#[cfg(...)]` guard is written around
            // statements. The attribute sits on the block expression.
            syn::Stmt::Expr(syn::Expr::Block(guarded), _) => {
                let gate = gate_of(&guarded.attrs);
                for inner in &guarded.block.stmts {
                    if let syn::Stmt::Expr(syn::Expr::Assign(assign), _) = inner
                        && bare_ident(&assign.left).as_deref() == Some(local.as_str())
                    {
                        walk_chain(&assign.right, &gate, &mut out)?;
                    }
                }
            }
            // `registry = registry.with_*(..);` at the top level.
            syn::Stmt::Expr(syn::Expr::Assign(assign), _)
                if bare_ident(&assign.left).as_deref() == Some(local.as_str()) =>
            {
                walk_chain(&assign.right, &gate_of(&assign.attrs), &mut out)?;
            }
            _ => {}
        }
    }

    if out.is_empty() {
        return Err(ClusterProjectionError::RegistryUnreadable {
            reason: format!(
                "it returns `{local}`, and nothing this can read registers a provider into it"
            ),
        });
    }
    Ok(out)
}

/// A one-segment path expression, which is how a local is named.
fn bare_ident(expr: &syn::Expr) -> Option<String> {
    let syn::Expr::Path(path) = expr else {
        return None;
    };
    if path.qself.is_some() || path.path.segments.len() != 1 {
        return None;
    }
    Some(last_segment(&path.path))
}

/// Whether a `let` pattern binds `name`, with or without `mut`.
fn binds(pat: &syn::Pat, name: &str) -> bool {
    match pat {
        syn::Pat::Ident(ident) => ident.ident == name,
        // `let registry: ProviderRegistry = ...`
        syn::Pat::Type(typed) => binds(&typed.pat, name),
        _ => false,
    }
}

/// The build condition a `#[cfg(...)]` attribute states.
///
/// Only `cfg(feature = "...")` reduces to a feature. Everything else -- `not`,
/// `all`, `target_os`, a bare `cfg_attr` -- is recorded as unreadable rather
/// than ignored: a registration nobody can place in a build must not be
/// indistinguishable from one that is always there.
fn gate_of(attrs: &[syn::Attribute]) -> FeatureGate {
    let Some(cfg) = attrs.iter().find(|a| a.path().is_ident("cfg")) else {
        return FeatureGate::Always;
    };
    let mut feature = None;
    let parsed = cfg.parse_nested_meta(|meta| {
        if meta.path.is_ident("feature")
            && let Ok(value) = meta.value()
            && let Ok(name) = value.parse::<syn::LitStr>()
        {
            feature = Some(name.value());
            return Ok(());
        }
        // Anything else in the predicate makes it more than one feature.
        feature = None;
        Err(meta.error("not a single-feature cfg"))
    });
    match (parsed, feature) {
        (Ok(()), Some(name)) => FeatureGate::Feature(name),
        _ => FeatureGate::Unreadable(
            cfg.meta
                .require_list()
                .map_or_else(|_| "cfg".to_owned(), |list| list.tokens.to_string()),
        ),
    }
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

/// What a backend's `features()` states, as two independent answers.
///
/// **Two, because the cache's constructors settle two different things.**
/// `CacheFeatures::new(x)` sets `prefix_watch` from its argument and `watch` to
/// `true` unconditionally, so a backend whose prefix flag is computed still
/// states plainly that it serves an exact-key watch -- postgres is exactly that
/// shape, and the catalogue understated it for as long as this returned one bool.
/// `without_watch()` settles both at once, in the other direction.
///
/// For a lock or a leader election there is one flag and `watch` is meaningless;
/// the caller reads it only for a cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Features {
    /// The positional flag: `prefix_watch` for a cache, `linearizable` otherwise.
    flag: Option<bool>,
    /// Whether an exact-key watch is served. Cache only.
    watch: Option<bool>,
}

/// Read the flags a backend's `features()` states, when it states them.
///
/// Three answers, and they are not interchangeable. `Some(flag)` is a fact the
/// description can be resolved against. `None` is "the backend decides at run
/// time", which contributes no capability -- see [`BackendCapabilities`]. An
/// error is "this parser cannot tell which flag it is reading", and that has to
/// stay an error: the feature structs are `#[non_exhaustive]` with positional
/// constructors, so a flag added upstream changes the arity, and silently
/// reading the wrong one would claim a capability the backend does not have.
///
/// The shapes, all of them from the SDK's own constructors:
///
/// * `new(true)` / `new(false)` -- stated outright.
/// * `new(self.something())` -- computed, so `None`.
/// * `without_watch()` -- states the answer in its name: the SDK sets both
///   `watch` and `prefix_watch` to `false`. Zero arguments, so the arity rule
///   below cannot be the one that judges it.
/// * an `if`/`else` whose branches are any of the above -- the backend picks a
///   shape from its own configuration, so the answer is whatever the branches
///   agree on and `None` when they do not.
fn features_flag(expr: &syn::Expr, ty: &str) -> Result<Features, ClusterProjectionError> {
    let fail = |reason: String| ClusterProjectionError::Capability {
        method: "features",
        ty: ty.to_owned(),
        reason,
    };

    match expr {
        // **Both branches are read, and an error in either one still fails.**
        // A conditional body is the backend saying the flag depends on how it
        // was configured -- redis serves prefix watch only with a subscriber
        // registry and a single node. Agreement is worth keeping (`if` around
        // two identical literals states a fact); disagreement is `None`, which
        // is exactly "decided at run time".
        syn::Expr::If(conditional) => {
            let then = tail_expr(&conditional.then_branch)
                .ok_or_else(|| fail("`if` branch has no trailing expression".to_owned()))?;
            let Some((_, otherwise)) = conditional.else_branch.as_ref() else {
                // No `else` means the `if` yields `()` unless every path
                // returns, which is not a shape this parser models.
                return Err(fail(
                    "`features` is an `if` with no `else`, so it has no single value to read"
                        .to_owned(),
                ));
            };
            // Each answer is combined on its own, because the branches may
            // agree about one and not the other: redis states `watch` both ways
            // (`new(...)` serves it, `without_watch()` does not) while its
            // prefix flag is computed in the branch that has one.
            let taken = features_flag(then, ty)?;
            let untaken = features_flag(otherwise, ty)?;
            let agree = |a: Option<bool>, b: Option<bool>| if a == b { a } else { None };
            Ok(Features {
                flag: agree(taken.flag, untaken.flag),
                watch: agree(taken.watch, untaken.watch),
            })
        }
        // An `else` arm, or a braced body inside one. `else if` arrives as
        // `Expr::If` above and recurses without help.
        syn::Expr::Block(block) => {
            let tail = tail_expr(&block.block)
                .ok_or_else(|| fail("block has no trailing expression".to_owned()))?;
            features_flag(tail, ty)
        }
        syn::Expr::Call(call) => features_call_flag(call, &fail),
        _ => Err(fail(
            "body is not a `*Features::` constructor call, or an `if` over them".to_owned(),
        )),
    }
}

/// One `*Features::` constructor call, by name and arity.
///
/// Split out so [`features_flag`]'s recursion stays readable; the arity refusal
/// is the whole reason this is fussy, so it names the constructor it refused.
fn features_call_flag(
    call: &syn::ExprCall,
    fail: &impl Fn(String) -> ClusterProjectionError,
) -> Result<Features, ClusterProjectionError> {
    let syn::Expr::Path(path) = &*call.func else {
        return Err(fail(
            "body is not a `*Features::` constructor call".to_owned(),
        ));
    };
    let constructor = last_segment(&path.path);

    match (constructor.as_str(), call.args.len()) {
        // The name is the statement. Checked before the arity rule, which
        // exists for `new` and would otherwise refuse this for taking none.
        ("without_watch", 0) => Ok(Features {
            flag: Some(false),
            watch: Some(false),
        }),
        // `new` serves an exact watch whatever its argument says -- that is the
        // meaning the SDK records on it, and it is why `watch` can be known here
        // while the prefix flag is not.
        ("new", 1) => match call.args.first() {
            Some(syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Bool(b),
                ..
            })) => Ok(Features {
                flag: Some(b.value),
                watch: Some(true),
            }),
            // The SDK-default derivation, pointed at by the wrong projector.
            // Still an error: this shape *has* a readable meaning, and reading
            // it here would attribute the default's capability to a plugin
            // backend.
            Some(arg) if is_cache_consistency_check(arg) => Err(fail(
                "argument is not a `bool` literal (a computed flag belongs to \
                 `project_sdk_defaults`, not a plugin backend)"
                    .to_owned(),
            )),
            // Anything else computed: the backend decides the flag at run time,
            // from what it connected to.
            _ => Ok(Features {
                flag: None,
                watch: Some(true),
            }),
        },
        (name, arity) => Err(fail(format!(
            "`*Features::{name}` takes {arity} arguments here; this parser models \
             `new(bool)` and `without_watch()`, so the constructors changed and the \
             projection must be updated"
        ))),
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
    let features = features_flag(expr, &ty)?;
    match features.flag {
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
    // **The exact-key watch, and only for a cache.** A lock and a leader
    // election have one flag each; `watch` is a cache word. Read separately
    // because the two answers come apart: postgres states `watch` outright while
    // declining the prefix flag, and redis states neither because its branches
    // disagree about both.
    //
    // `runtime_determined` is not pushed twice -- it names the *method*, and
    // `features` is already in it whenever any of its answers is undecided.
    if primitive == ClusterPrimitive::Cache {
        match features.watch {
            Some(true) => {
                caps.insert(CapabilityId::new(capabilities::CACHE_WATCH)?);
            }
            Some(false) => {}
            None => {
                if !runtime_determined.contains(&"features") {
                    runtime_determined.push("features");
                }
            }
        }
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
