//! The GDL vocabulary, as starlark globals.
//!
//! Every parameter is `require = named`: GDL is keyword-only by design, so a
//! description reads as a set of labelled facts rather than a positional
//! signature nobody can remember. Lists are `UnpackList<&'v T>` rather than
//! `UnpackList<Value>` so a wrong-typed element fails to unpack with starlark's
//! own message, naming both the expected and the actual type.
//!
//! Note what these functions deliberately cannot do: none of them reads the
//! filesystem, the environment, the clock, or the deployment profile. A
//! description file therefore cannot branch on a resolution input even if the
//! dialect let it branch at all -- which is the third layer of
//! `cpt-gearbox-fr-gdl-declarative`, and the reason it holds structurally
//! rather than by review.

// These fire on code `#[starlark_module]` generates, not on anything written
// here: the macro emits one wrapper per vocabulary function, each taking every
// declared parameter and returning `Result` whether or not the body can fail.
// `allow` rather than `expect` because which of them fires depends on the
// expansion, and an unfulfilled `expect` is itself an error.
#![allow(
    clippy::needless_pass_by_value,
    clippy::too_many_arguments,
    clippy::too_many_lines,
    clippy::unnecessary_wraps,
    reason = "artifacts of #[starlark_module] expansion, not of hand-written code"
)]

use gearbox_ir::ClusterPrimitive;
use starlark::environment::{Globals, GlobalsBuilder};
use starlark::eval::Evaluator;
use starlark::starlark_module;
use starlark::values::Value;
use starlark::values::list::UnpackList;
use starlark::values::none::NoneType;

use crate::records::{
    CargoRecord, ClusterPluginRecord, ClusterRequireRecord, ConsumeRecord, DocsRecord,
    EndpointRecord, GrpcRecord, LifecycleRecord, ProvideRecord, RestRecord, RoleRecord,
};
use crate::sink::{GdlSink, GearDecl};
use crate::values::GdlEnum;
use crate::vocabulary;

/// Pull the sink out of the evaluator.
///
/// A missing sink is a wiring bug in this crate, not a user error, so it fails
/// the evaluation with an internal message rather than producing a diagnostic
/// that would look like the description's fault.
fn sink<'a>(eval: &'a Evaluator<'_, '_, '_>) -> anyhow::Result<&'a GdlSink> {
    eval.extra
        .and_then(|e| e.downcast_ref::<GdlSink>())
        .ok_or_else(|| anyhow::anyhow!("internal error: no GdlSink installed on the evaluator"))
}

/// Refuse a field the Rust attributes own.
///
/// Naming the owning attribute is the point: "unknown argument" would leave a
/// gear author guessing where the fact belongs, whereas this tells them it
/// already has a home and where (`cpt-gearbox-fr-gdl-no-restatement`).
fn restated(field: &str, owner: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "`{field}` is projected from Rust and must not be declared here; it is owned by \
         {owner}. Remove it from gear.gdl."
    )
}

#[starlark_module]
fn gdl_vocabulary(builder: &mut GlobalsBuilder) {
    /// `cargo(...)` -- where a gear's or SDK's crate lives.
    ///
    /// Spelled `crate_name` rather than `crate` because the starlark parameter
    /// name is the Rust identifier and `r#crate` is not a legal raw identifier.
    /// Unambiguous next to `lib` regardless: one is the package, one is the
    /// library target.
    fn cargo(
        #[starlark(require = named)] crate_name: &str,
        #[starlark(require = named)] lib: &str,
        #[starlark(require = named, default = ".")] path: &str,
        #[starlark(require = named)] features: Option<UnpackList<String>>,
        #[starlark(require = named, default = true)] default_features: bool,
        #[starlark(require = named)] link: Option<UnpackList<String>>,
        #[starlark(require = named)] attr: Option<&str>,
    ) -> anyhow::Result<CargoRecord> {
        Ok(CargoRecord {
            crate_name: crate_name.to_owned(),
            lib_ident: lib.to_owned(),
            path: path.to_owned(),
            features: features.map(|l| l.items).unwrap_or_default(),
            default_features,
            link: link.map(|l| l.items).unwrap_or_default(),
            attr: attr.map(str::to_owned),
        })
    }

    /// `docs(...)` -- override where this gear's documents live.
    ///
    /// Only needed when they are not at `docs/` beside the gear or one level up.
    fn docs(
        #[starlark(require = named)] prd: Option<&str>,
        #[starlark(require = named)] design: Option<&str>,
        #[starlark(require = named)] adr: Option<UnpackList<String>>,
        #[starlark(require = named)] openapi: Option<&str>,
    ) -> anyhow::Result<DocsRecord> {
        Ok(DocsRecord {
            prd: prd.map(str::to_owned),
            design: design.map(str::to_owned),
            adr: adr.map(|l| l.items).unwrap_or_default(),
            openapi: openapi.map(str::to_owned),
        })
    }

    /// `lifecycle(...)` -- start/stop behaviour, mirroring the gear macro's clause.
    fn lifecycle(
        #[starlark(require = named)] entry: Option<&str>,
        #[starlark(require = named)] stop_timeout: Option<&str>,
        #[starlark(require = named, default = false)] await_ready: bool,
    ) -> anyhow::Result<LifecycleRecord> {
        Ok(LifecycleRecord {
            entry: entry.map(str::to_owned),
            stop_timeout: stop_timeout.map(str::to_owned),
            await_ready,
        })
    }

    /// `endpoint(...)` -- something the gear listens on, or is mounted on.
    fn endpoint(
        #[starlark(require = named)] name: &str,
        #[starlark(require = named)] config_key: Option<&str>,
        #[starlark(require = named)] default_port: Option<u32>,
        #[starlark(require = named)] via: Option<&str>,
    ) -> anyhow::Result<EndpointRecord> {
        let port = match default_port {
            Some(p) => Some(u16::try_from(p).map_err(|_| {
                anyhow::anyhow!("default_port {p} is not a valid TCP port (0-65535)")
            })?),
            None => None,
        };
        Ok(EndpointRecord {
            name: name.to_owned(),
            config_key: config_key.map(str::to_owned),
            default_port: port,
            via: via.map(str::to_owned),
        })
    }

    /// `rest(...)` -- a contract's REST projection.
    fn rest(
        #[starlark(require = named)] base_path: &str,
        #[starlark(require = named, default = false)] require_full_coverage: bool,
        #[starlark(require = named)] visibility: Option<&str>,
    ) -> anyhow::Result<RestRecord> {
        if let Some(v) = visibility {
            anyhow::ensure!(
                matches!(v, "exposed" | "internal"),
                "visibility must be \"exposed\" or \"internal\", got {v:?}"
            );
        }
        Ok(RestRecord {
            base_path: base_path.to_owned(),
            require_full_coverage,
            visibility: visibility.map(str::to_owned),
        })
    }

    /// `grpc(...)` -- a contract's gRPC projection.
    fn grpc(
        #[starlark(require = named)] package: &str,
        #[starlark(require = named)] service: &str,
        #[starlark(require = named)] stubs_module: &str,
    ) -> anyhow::Result<GrpcRecord> {
        Ok(GrpcRecord {
            package: package.to_owned(),
            service: service.to_owned(),
            stubs_module: stubs_module.to_owned(),
        })
    }

    /// `provide(...)` -- a contract this gear provides.
    fn provide<'v>(
        #[starlark(require = named)] contract: &str,
        #[starlark(require = named)] rust: &str,
        #[starlark(require = named)] sdk: &'v CargoRecord,
        #[starlark(require = named)] local: Option<&str>,
        #[starlark(require = named)] rest: Option<&'v RestRecord>,
        #[starlark(require = named)] grpc: Option<&'v GrpcRecord>,
        #[starlark(require = named)] policies: Option<UnpackList<String>>,
        // Accepted only to be refused by name: see `restated` below.
        #[starlark(require = named)] version: Option<&str>,
        #[starlark(require = named)] transports: Option<Value<'v>>,
        #[starlark(require = named)] kind: Option<&'v GdlEnum>,
    ) -> anyhow::Result<ProvideRecord> {
        if version.is_some() {
            return Err(restated("version", "#[toolkit::contract(version = ...)]"));
        }
        if kind.is_some() {
            return Err(restated(
                "kind",
                "the contract trait's name suffix (Api / Embedded / Backend / Extension)",
            ));
        }
        if transports.is_some() {
            return Err(restated(
                "transports",
                "the `<Base>Rest` / `<Base>Grpc` projection traits beside the base trait \
                 in the sdk crate",
            ));
        }

        Ok(ProvideRecord {
            contract: contract.to_owned(),
            rust: rust.to_owned(),
            sdk: sdk.clone(),
            local: local.map(str::to_owned),
            rest: rest.cloned(),
            grpc: grpc.cloned(),
            policies: policies.map(|l| l.items).unwrap_or_default(),
        })
    }

    /// `consume(...)` -- a declared contract edge, and the only kind of edge
    /// the resolver may ever place across a process boundary.
    fn consume<'v>(
        #[starlark(require = named)] contract: &str,
        #[starlark(require = named)] rust: &str,
        #[starlark(require = named)] sdk: &'v CargoRecord,
        #[starlark(require = named)] from_: &str,
        #[starlark(require = named, default = false)] critical: bool,
        #[starlark(require = named)] resolving_client: Option<&str>,
        #[starlark(require = named)] version: Option<&str>,
        #[starlark(require = named)] kind: Option<&'v GdlEnum>,
    ) -> anyhow::Result<ConsumeRecord> {
        if version.is_some() {
            return Err(restated("version", "#[toolkit::contract(version = ...)]"));
        }
        if kind.is_some() {
            return Err(restated("kind", "the contract trait's name suffix"));
        }
        Ok(ConsumeRecord {
            contract: contract.to_owned(),
            rust: rust.to_owned(),
            sdk: sdk.clone(),
            from: from_.to_owned(),
            critical,
            resolving_client: resolving_client.map(str::to_owned),
        })
    }

    /// `cluster_plugin(...)` -- where a backend plugin crate lives.
    ///
    /// Providers themselves are projected from
    /// `ClusterGear::provider_registry()`; this only says where to look and
    /// carries the two flags Rust does not state.
    fn cluster_plugin<'v>(
        #[starlark(require = named)] package: &'v CargoRecord,
        #[starlark(require = named, default = false)] process_local: bool,
        #[starlark(require = named, default = false)] needs_credentials: bool,
        #[starlark(require = named)] backend: Option<&str>,
    ) -> anyhow::Result<ClusterPluginRecord> {
        Ok(ClusterPluginRecord {
            package: package.clone(),
            process_local,
            needs_credentials,
            backend: backend.map(str::to_owned),
        })
    }

    /// `role(...)` -- accepted for forward compatibility, excluded from
    /// resolution. The runtime has no role concept.
    fn role(
        #[starlark(require = named)] name: &str,
        #[starlark(require = named)] directory_name: Option<&str>,
        #[starlark(require = named, default = false)] sharded: bool,
        #[starlark(require = named, default = false)] instance_addressable: bool,
    ) -> anyhow::Result<RoleRecord> {
        Ok(RoleRecord {
            name: name.to_owned(),
            directory_name: directory_name.map(str::to_owned),
            sharded,
            instance_addressable,
        })
    }

    /// `gear(...)` -- the one declaration a `gear.gdl` makes.
    fn gear<'v>(
        #[starlark(require = named)] name: Option<&str>,
        #[starlark(require = named)] description: Option<&str>,
        #[starlark(require = named)] category: Option<&str>,
        #[starlark(require = named)] visibility: Option<&str>,
        #[starlark(require = named)] package: &'v CargoRecord,
        // A locator, like `cluster_plugins`: nothing in a gear's own crate says
        // where its SDK lives, and the SDK is what declares the plugin-API
        // traits this gear expects or fills.
        #[starlark(require = named)] sdk: Option<&'v CargoRecord>,
        // Escape hatch, not the primary mechanism: only for a crate whose
        // extension point cannot be read (the bss-rate-provider plugins
        // implement no trait with `Plugin` in the name). Same shape as `attr`
        // on `cargo(...)` and `backend` on `cluster_plugin(...)`.
        #[starlark(require = named)] plugin_interface: Option<&str>,
        #[starlark(require = named)] docs: Option<&'v DocsRecord>,
        #[starlark(require = named)] provides: Option<UnpackList<&'v ProvideRecord>>,
        #[starlark(require = named)] consumes: Option<UnpackList<&'v ConsumeRecord>>,
        #[starlark(require = named)] requires: Option<UnpackList<&'v ClusterRequireRecord>>,
        #[starlark(require = named)] serves: Option<UnpackList<&'v EndpointRecord>>,
        #[starlark(require = named)] cluster_plugins: Option<UnpackList<&'v ClusterPluginRecord>>,
        #[starlark(require = named)] roles: Option<UnpackList<&'v RoleRecord>>,
        #[starlark(require = named)] config_schema: Option<&str>,
        // Accepted only to be refused by name, so the diagnostic can say which
        // attribute owns the fact instead of "unknown argument".
        #[starlark(require = named)] id: Option<&str>,
        #[starlark(require = named)] runtime_caps: Option<UnpackList<&'v GdlEnum>>,
        #[starlark(require = named)] colocated_deps: Option<UnpackList<String>>,
        #[starlark(require = named)] lifecycle: Option<&'v LifecycleRecord>,
        #[starlark(require = named)] client: Option<&str>,
        // Accepted as an untyped value because it exists only to be refused;
        // binding it to a record type would imply the surface still exists.
        #[starlark(require = named)] cluster_providers: Option<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        for (present, field, owner) in [
            (id.is_some(), "id", "#[toolkit::gear(name = ...)]"),
            (
                runtime_caps.is_some(),
                "runtime_caps",
                "#[toolkit::gear(capabilities = [...])]",
            ),
            (
                colocated_deps.is_some(),
                "colocated_deps",
                "#[toolkit::gear(deps = [...])]",
            ),
            (
                lifecycle.is_some(),
                "lifecycle",
                "#[toolkit::gear(lifecycle(...))]",
            ),
            (client.is_some(), "client", "#[toolkit::gear(client = ...)]"),
            (
                cluster_providers.is_some(),
                "cluster_providers",
                "the with_*_provider calls in ClusterGear::provider_registry()",
            ),
        ] {
            if present {
                return Err(restated(field, owner));
            }
        }

        sink(eval)?.set_gear(GearDecl {
            name: name.map(str::to_owned),
            description: description.map(str::to_owned),
            category: category.map(str::to_owned),
            visibility: visibility.map(str::to_owned),
            package: Some(package.clone()),
            sdk: sdk.cloned(),
            plugin_interface: plugin_interface.map(str::to_owned),
            docs: docs.cloned(),
            provides: provides
                .map(|l| l.items.into_iter().cloned().collect())
                .unwrap_or_default(),
            consumes: consumes
                .map(|l| l.items.into_iter().cloned().collect())
                .unwrap_or_default(),
            requires: requires
                .map(|l| l.items.into_iter().cloned().collect())
                .unwrap_or_default(),
            serves: serves
                .map(|l| l.items.into_iter().cloned().collect())
                .unwrap_or_default(),
            cluster_plugins: cluster_plugins
                .map(|l| l.items.into_iter().cloned().collect())
                .unwrap_or_default(),
            declared_roles: roles
                .map(|l| l.items.into_iter().cloned().collect())
                .unwrap_or_default(),
            config_schema: config_schema.map(str::to_owned),
        });
        Ok(NoneType)
    }

    /// `fail(msg)` -- a declarative assertion. Permitted because it states a
    /// fact about validity rather than choosing between alternatives.
    fn fail(#[starlark(require = pos)] message: &str) -> anyhow::Result<NoneType> {
        Err(anyhow::anyhow!("{message}"))
    }
}

/// The `cluster.*` requirement constructors.
///
/// A namespace of *functions*, unlike `cap`/`transport`/... which are
/// namespaces of values -- so `GlobalsBuilder::namespace` is the right tool
/// here and an attribute-bearing value is the right tool there.
#[starlark_module]
/// `cluster.cache(...)`, `cluster.leader_election(...)`, `cluster.lock(...)`.
///
/// `profile` is mandatory and has no default. It is a join key against the
/// gear's own `impl ClusterProfile { const NAME }`, and the SDK turns it into
/// `ClientScope::new("cluster:{name}")` -- so a wrong value is not a typo that
/// degrades, it is a scope nothing ever registered, failing at startup with
/// `ProfileNotBound`. A `"default"` fallback would have been silently wrong for
/// the platform's only real consumer, which binds `"event-broker"`.
fn cluster_namespace(builder: &mut GlobalsBuilder) {
    fn cache<'v>(
        #[starlark(require = named)] profile: &str,
        #[starlark(require = named)] capabilities: Option<UnpackList<&'v GdlEnum>>,
    ) -> anyhow::Result<ClusterRequireRecord> {
        cluster_require(ClusterPrimitive::Cache, profile, capabilities)
    }

    fn leader_election<'v>(
        #[starlark(require = named)] profile: &str,
        #[starlark(require = named)] capabilities: Option<UnpackList<&'v GdlEnum>>,
    ) -> anyhow::Result<ClusterRequireRecord> {
        cluster_require(ClusterPrimitive::LeaderElection, profile, capabilities)
    }

    fn lock<'v>(
        #[starlark(require = named)] profile: &str,
        #[starlark(require = named)] capabilities: Option<UnpackList<&'v GdlEnum>>,
    ) -> anyhow::Result<ClusterRequireRecord> {
        cluster_require(ClusterPrimitive::Lock, profile, capabilities)
    }
}

/// Shared body of the three `cluster.*` constructors.
///
/// Capability names are resolved against the primitive, so asking for
/// `prefix_watch` on a lock is refused here rather than silently carried into
/// the catalogue -- `prefix_watch` is a cache property and a lock that claimed
/// it would describe something that does not exist.
fn cluster_require(
    primitive: ClusterPrimitive,
    profile: &str,
    capabilities: Option<UnpackList<&GdlEnum>>,
) -> anyhow::Result<ClusterRequireRecord> {
    let capabilities = capabilities
        .map(|list| {
            list.items
                .iter()
                .map(|v| {
                    vocabulary::cluster_capability(v, primitive)
                        .map(str::to_owned)
                        .map_err(|e| anyhow::anyhow!(e))
                })
                .collect::<anyhow::Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();

    Ok(ClusterRequireRecord {
        primitive: primitive.slug().to_owned(),
        scope: profile.to_owned(),
        capabilities,
    })
}

/// Everything GDL adds on top of whatever the builder already holds.
///
/// Factored out of [`gear_globals`] so that [`gear_vocabulary`] can apply the
/// same additions to an empty builder. One definition, two bases -- the
/// alternative, subtracting the standard set from the full one, is wrong (see
/// [`gear_vocabulary`]).
fn gear_additions(builder: &mut GlobalsBuilder) {
    gdl_vocabulary(builder);
    for (name, namespace) in vocabulary::ALL_NAMESPACES {
        builder.set(name, *namespace);
    }
    builder.namespace("cluster", cluster_namespace);
}

/// Build the globals a `gear.gdl` is evaluated against.
///
/// `GlobalsBuilder::standard()` rather than `new()`: descriptions legitimately
/// use `len`, string methods and the like. What matters is that nothing here
/// reaches the outside world.
#[must_use]
pub fn gear_globals() -> Globals {
    GlobalsBuilder::standard().with(gear_additions).build()
}

/// The gear-side GDL vocabulary alone, with no Starlark standard underneath.
///
/// Exists so the editor's grammar is generated from the very globals the
/// interpreter evaluates against, rather than from a list kept in step by hand
/// (`tests/export_grammar.rs`).
///
/// Deliberately *not* `gear_globals()` minus `GlobalsBuilder::standard()`:
/// `fail` is a Starlark standard global that GDL overrides on purpose, so a
/// subtraction by name would drop it and the editor would quietly stop
/// colouring it.
#[must_use]
pub fn gear_vocabulary() -> Globals {
    GlobalsBuilder::new().with(gear_additions).build()
}
