//! Diagnostics.
//!
//! Every diagnostic the engine can emit is declared here, once, as an enum
//! variant. That makes the set exhaustive and greppable, lets the compiler catch
//! a mistyped code, and gives each code a single home for its title, default
//! severity, and doc comment.
//!
//! Two rules from the PRD are enforced structurally rather than by review:
//!
//! - `cpt-gearbox-nfr-actionable-diagnostics` -- every error-severity code
//!   carries a remedy. [`Diagnostic::error`] demands one.
//! - `cpt-gearbox-nfr-evidence-cited` -- every code asserting the runtime does
//!   not support something carries a `file:line` in `gears-rust`.
//!   [`DiagnosticCode::requires_evidence`] marks those, and
//!   [`Diagnostic::validate`] rejects them without it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::NodeId;

/// How much a diagnostic matters.
///
/// `Error` blocks writing the lock and generating artifacts (unless explicitly
/// overridden); the rest are informational. Resolution itself never stops on an
/// error -- a partial product plus its errors is more useful to a UI than
/// nothing at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Informational; the smallest thing worth saying.
    Hint,
    /// Worth knowing, no action implied.
    Info,
    /// The product resolved, but not the way it was asked for.
    Warning,
    /// The product is invalid. Blocks lock write and generation.
    Error,
}

impl Severity {
    #[must_use]
    pub const fn is_error(self) -> bool {
        matches!(self, Self::Error)
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hint => "hint",
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }
}

impl std::fmt::Display for Severity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Which part of the pipeline produced a diagnostic.
///
/// Mirrors the numeric ranges of the codes, so a reader can place a code without
/// consulting a table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticDomain {
    /// `GBX01xx` -- parsing and evaluating GDL.
    Gdl,
    /// `GBX02xx` -- cross-checking `gear.gdl` against Rust source.
    Validate,
    /// `GBX03xx` -- process topology and structural constraints.
    Topology,
    /// `GBX04xx` -- contract bindings and severability.
    Binding,
    /// `GBX05xx` -- cluster capabilities and providers.
    Cluster,
    /// `GBX06xx` -- capabilities the runtime does not implement.
    RuntimeGap,
    /// `GBX07xx` -- artifact generation.
    Generator,
}

impl DiagnosticDomain {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Gdl => "gdl",
            Self::Validate => "validate",
            Self::Topology => "topology",
            Self::Binding => "binding",
            Self::Cluster => "cluster",
            Self::RuntimeGap => "runtime-gap",
            Self::Generator => "generator",
        }
    }
}

/// Declares the diagnostic catalogue.
///
/// Each entry is `Variant = "CODE", domain, default severity, evidence
/// requirement, title`. The doc comment on a variant is the canonical
/// explanation of the condition, and is what a generated reference page shows.
macro_rules! diagnostic_codes {
    (
        $(
            $(#[doc = $doc:literal])+
            $variant:ident = $code:literal, $domain:ident, $severity:ident, $evidence:literal, $title:literal;
        )+
    ) => {
        /// A stable diagnostic code.
        ///
        /// Serializes as its string form (`"GBX0402"`) so a code in a
        /// `product.lock` or an RPC payload stays readable and stable even if
        /// this enum is reordered.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
        #[ts(type = "string")]
        #[non_exhaustive]
        pub enum DiagnosticCode {
            $(
                $(#[doc = $doc])+
                $variant,
            )+
        }

        impl DiagnosticCode {
            /// Every code, in declaration order.
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            /// The stable string form, e.g. `"GBX0402"`.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $code,)+
                }
            }

            /// Which pipeline stage owns this code.
            #[must_use]
            pub const fn domain(self) -> DiagnosticDomain {
                match self {
                    $(Self::$variant => DiagnosticDomain::$domain,)+
                }
            }

            /// The severity used unless a call site deliberately raises or lowers it.
            #[must_use]
            pub const fn default_severity(self) -> Severity {
                match self {
                    $(Self::$variant => Severity::$severity,)+
                }
            }

            /// Whether this code asserts a runtime limitation and therefore must
            /// cite a `file:line` in `gears-rust`
            /// (`cpt-gearbox-nfr-evidence-cited`).
            #[must_use]
            pub const fn requires_evidence(self) -> bool {
                match self {
                    $(Self::$variant => $evidence,)+
                }
            }

            /// A short human title, independent of any particular occurrence.
            #[must_use]
            pub const fn title(self) -> &'static str {
                match self {
                    $(Self::$variant => $title,)+
                }
            }

            /// Parse a code from its string form.
            ///
            /// # Errors
            /// Returns [`UnknownDiagnosticCode`] if `s` is not a known code.
            pub fn parse(s: &str) -> Result<Self, UnknownDiagnosticCode> {
                match s {
                    $($code => Ok(Self::$variant),)+
                    other => Err(UnknownDiagnosticCode(other.to_owned())),
                }
            }
        }
    };
}

diagnostic_codes! {
    // ---------------------------------------------------------------- GBX01xx
    /// A `.gdl` file could not be parsed as Starlark.
    GdlParse = "GBX0101", Gdl, Error, false, "GDL parse error";

    /// A `.gdl` file parsed but failed during evaluation.
    GdlEval = "GBX0102", Gdl, Error, false, "GDL evaluation error";

    /// A GDL file used a construct that encodes a decision -- `if`, `for`,
    /// `while`, `def`, `lambda`, a conditional expression, a comprehension, or a
    /// boolean short-circuit.
    ///
    /// GDL describes facts; the resolver makes decisions. Allowing a branch here
    /// would move a decision out of the resolver and destroy determinism and
    /// explainability (`cpt-gearbox-fr-gdl-declarative`).
    GdlForbiddenConstruct = "GBX0103", Gdl, Error, false, "forbidden GDL construct";

    /// A `load()` referenced a path outside the declaring file's source root.
    GdlLoadEscape = "GBX0104", Gdl, Error, false, "GDL load escapes its source root";

    /// A file declared no `gear()`/`product()`, or more than one.
    GdlCardinality = "GBX0105", Gdl, Error, false, "wrong number of top-level declarations";

    /// A call received an argument this vocabulary does not define.
    GdlUnknownArgument = "GBX0106", Gdl, Error, false, "unknown GDL argument";

    /// A construct was accepted for forward compatibility but excluded from
    /// resolution.
    GdlDowngraded = "GBX0107", Gdl, Warning, true, "GDL construct accepted but not resolved";

    /// A gear's `category` is not one the platform uses.
    ///
    /// A warning rather than an error, deliberately. The taxonomy is visibly
    /// still settling -- `cluster` is filed under `serverless` and
    /// `account-management` under `oss` -- so treating the set as closed would
    /// claim more than the evidence supports. It still catches a typo, which is
    /// the failure that matters: a category nothing else uses puts a gear in a
    /// bucket of one.
    GdlUnknownCategory = "GBX0108", Gdl, Warning, false, "gear category is not one the platform uses";

    /// A declared documentation or specification path does not exist.
    ///
    /// An error, unlike the absence of a file found by convention: a gear may
    /// genuinely have no PRD, but a path written by hand and pointing nowhere is
    /// a typo.
    GdlMissingDocPath = "GBX0109", Gdl, Error, false, "declared documentation path does not exist";

    /// Two declarations scoped to the same profile collide.
    GdlDuplicateProfileScoped = "GBX0110", Gdl, Error, false, "duplicate profile-scoped declaration";

    /// Resolution was asked for a profile the description does not declare.
    ///
    /// A caller's mistake rather than the description's, and reported rather
    /// than defaulted: silently resolving `embedded` when someone asked for
    /// `prod` would produce a plausible product with the wrong topology, which
    /// is the one outcome worse than refusing.
    GdlUnknownProfile = "GBX0111", Gdl, Error, false, "unknown deployment profile";

    /// A declared `config_schema` names a struct the gear's crate does not
    /// declare, or the crate deserializes more than one type as its config.
    ///
    /// An error for the same reason `GBX0109` is: a locator written by hand and
    /// pointing at nothing is a typo, and a configuration surface projected from
    /// the wrong struct would offer fields the gear never reads.
    GdlConfigStructNotFound = "GBX0112", Gdl, Error, false, "config_schema names no usable struct";

    /// A `config = {...}` value does not match the type its gear declares for
    /// that field.
    ///
    /// An error rather than a warning: unlike an unfamiliar category (GBX0108),
    /// there is no reading under which the product still works. A `bind_addr`
    /// set to `True` builds a binary that starts and then fails to deserialize
    /// its own generated configuration -- the same failure, moved somewhere
    /// nobody is looking.
    ///
    /// Only fields in the projected schema are type-checked. A key the schema
    /// does not name is [`GdlUnknownConfigKey`], not this code.
    GdlConfigTypeMismatch = "GBX0113", Gdl, Error, false, "config value does not match the declared field type";

    /// A config key a gear declares as an endpoint's `config_key` was also set
    /// in the description, where it has no effect.
    ///
    /// A warning, not an error: the product resolves and builds, and the value
    /// is simply not the one used. But it is worth saying, because the failure
    /// it prevents is an operator setting a bind address, seeing the generated
    /// file disagree, and having nothing to read that explains why. The port
    /// comes from the topology the resolver decided; a value written by hand
    /// would be describing a product that was not resolved.
    GdlConfigKeyDerived = "GBX0114", Gdl, Warning, false, "config key is derived from the topology and cannot be set here";

    /// A `config = {...}` key is not a field the gear's projected schema names.
    ///
    /// An error because generated YAML is deserialized with `deny_unknown_fields`:
    /// writing the key produces a file the runtime refuses at startup. A field
    /// the gear reads must appear in the schema; a typo must not reach the file.
    GdlUnknownConfigKey = "GBX0115", Gdl, Error, false, "config key is not declared by the gear";

    /// A credential written into the description, where it would be committed.
    ///
    /// An error rather than a rewrite: replacing the value would leave the
    /// original in the `.gdl` file, which is the place the requirement names.
    /// The author has to take it out, and the help says what to write instead.
    GdlLiteralSecret = "GBX0116", Gdl, Error, false, "a credential is written into the description";

    // ---------------------------------------------------------------- GBX02xx
    // GBX0201-GBX0205 are deliberately absent. They compared a `gear.gdl`
    // restatement of the gear id, co-location dependencies, runtime
    // capabilities, provided contracts and consumed contracts against the Rust
    // attributes that also carried them. Under the macro-projected catalogue
    // (ADR `cpt-gearbox-adr-macro-projected-catalogue`) those facts exist in
    // exactly one place, so there is no second copy left to diverge and nothing
    // for a comparison to report. Their replacement is GBX0210, which refuses
    // the restatement outright rather than detecting it afterwards.
    //
    // The codes are not reused: a lock or a transcript naming GBX0203 should
    // stay findable rather than silently meaning something else.

    /// The gear's name is not the kebab-case form of the annotated struct's
    /// identifier.
    ///
    /// `#[toolkit::consumes]` derives the owner gear from the struct identifier,
    /// not from `#[toolkit::gear(name = ...)]`, and uses it as the configuration
    /// key for the static endpoint override. A mismatch means that override key
    /// never resolves, and the runtime only warns.
    ValidateOwnerGearMismatch = "GBX0206", Validate, Error, true, "gear name is not kebab-case of its struct identifier";

    // GBX0207 is deliberately absent. It would have compared a contract trait's
    // name against its `#[toolkit::contract]` -- and both halves are already
    // compile errors in `toolkit-contract-macros`:
    //
    //   * an unrecognised suffix is rejected by `ContractKind::from_suffix`
    //     (`libs/toolkit-contract-macros/src/parse.rs:70`);
    //   * a trailing major marker that disagrees with `version` is rejected a
    //     few lines below it (`parse.rs:83`), citing ADR-0007.
    //
    // So a crate exhibiting either does not build, and a catalogue is only ever
    // assembled from crates that do. Retired for the same reason as
    // GBX0201-GBX0205 but by a different mechanism: not "one authority" but
    // "the divergence cannot survive compilation".
    //
    // One residual case does compile: an *unmarked* trait name with
    // `version = "v2"` or later. The macro permits it on purpose -- ADR-0007
    // makes an unmarked name unconstrained, because a v1 contract keeps its
    // unmarked name when v2 is added beside it. Reporting it would contradict
    // the platform's own decision, and the tree contains no instance, so it is
    // recorded as a known gap rather than as a code. What *is* checked is that
    // the projector's suffix and marker rules still agree with the macro's, in
    // `crates/gearbox-ir/tests/contract_shape.rs`.

    /// A selected gear crate has no `gear.gdl`.
    ValidateMissingDescription = "GBX0208", Validate, Error, false, "gear has no gear.gdl";

    /// The declared library identifier does not match the crate's actual one.
    ///
    /// A crate without an explicit `[lib]` section takes its library identifier
    /// from the package name, which is why the identifier must be declared
    /// rather than derived.
    ValidateLibIdentMismatch = "GBX0209", Validate, Error, false, "declared library identifier does not match the crate";

    /// A description restated a fact that is projected from the Rust attributes.
    ///
    /// Refusing rather than tolerating is what keeps the projection decision
    /// alive: without an active rejection the mirrored surface returns by
    /// accretion, one convenient field at a time, and the design decays back
    /// into a cross-check (`cpt-gearbox-fr-gdl-no-restatement`).
    ValidateRestatement = "GBX0210", Validate, Error, false, "description restates a projected fact";

    /// A gear's `#[toolkit::gear]` attribute could not be located
    /// unambiguously.
    ///
    /// Either the scanned tree held none, or it held several -- one crate may
    /// legitimately declare more than one gear, and `gears/mini-chat/mini-chat`
    /// declares three. Projection is meaningless until exactly one attribute is
    /// identified, so this is an error rather than a guess
    /// (`cpt-gearbox-fr-attribute-location`).
    ValidateAttributeAmbiguous = "GBX0211", Validate, Error, false, "gear attribute could not be located unambiguously";

    /// A description exposes a configuration field its gear's struct does not
    /// declare.
    ///
    /// The check that keeps `exposes` from becoming a second copy of the struct.
    /// A curated list is a product judgement and legitimately declared, but it
    /// refers to Rust facts, and a reference that no longer resolves is drift --
    /// detected here rather than surfacing as a control writing a key the gear
    /// ignores.
    ValidateConfigFieldUnknown = "GBX0212", Validate, Error, false, "exposed config field is not declared by the gear";

    // ---------------------------------------------------------------- GBX03xx
    /// A selected or depended-upon gear is not in the catalogue.
    TopologyUnknownGear = "GBX0301", Topology, Error, false, "unknown gear";

    /// Co-location dependencies form a cycle.
    TopologyDepsCycle = "GBX0302", Topology, Error, false, "co-location dependency cycle";

    /// A process contains more than one REST host gear.
    ///
    /// The runtime registry permits exactly one.
    TopologyMultipleRestHost = "GBX0303", Topology, Error, true, "more than one REST host in a process";

    /// A process contains more than one gRPC hub gear.
    TopologyMultipleGrpcHub = "GBX0304", Topology, Error, true, "more than one gRPC hub in a process";

    /// A process exposes REST interfaces but contains no REST host to mount them.
    TopologyRestWithoutHost = "GBX0305", Topology, Error, false, "REST gears with no REST host";

    /// A process contains a database-backed gear but no database is configured.
    TopologyDbWithoutDatabase = "GBX0306", Topology, Error, false, "database gear with no database configured";

    /// The requested shape cannot exist in the `embedded` profile, which is a
    /// single process by definition.
    TopologyEmbeddedViolation = "GBX0307", Topology, Warning, false, "request is incompatible with the embedded profile";

    /// Directory-based discovery was selected but the host process has no
    /// directory server gear.
    TopologyNoOrchestrator = "GBX0308", Topology, Error, false, "directory discovery without a directory server";

    /// Directory-based discovery was selected but the host process has no gRPC
    /// hub.
    ///
    /// The host's worker-spawn phase blocks waiting for the gRPC hub endpoint,
    /// because that is the directory address it hands to each child.
    TopologyNoGrpcHub = "GBX0309", Topology, Error, true, "directory discovery without a gRPC hub";

    /// A worker process has no resolvable executable path.
    TopologyNoTargetDir = "GBX0310", Topology, Error, false, "worker has no resolvable executable path";

    /// A gear in the closure was not placed in any process.
    TopologyOrphanGear = "GBX0311", Topology, Error, false, "gear placed in no process";

    /// A worker process contains a REST host gear.
    ///
    /// A worker serves over its own out-of-process HTTP router, not through the
    /// API gateway, so a REST host there would never receive traffic.
    TopologyRestHostInWorker = "GBX0312", Topology, Error, true, "REST host in a worker process";

    /// A `host_workers` profile produced workers but no host to spawn them.
    ///
    /// Spawn specs are attached to the host process. Without one they are
    /// dropped, and the workers the lock named never start.
    TopologyNoHost = "GBX0313", Topology, Error, false, "workers have no host process to spawn them";

    // ---------------------------------------------------------------- GBX04xx
    /// This consumer and provider could be placed in separate processes, but the
    /// dependency between them is not declared as a contract consumption.
    ///
    /// Not an error: it is the actionable work list
    /// (`cpt-gearbox-fr-report-cuttable-if-declared`). Direct type-keyed client
    /// lookups are widespread, so separating an undeclared pair would fail at
    /// runtime; the accompanying help text is the exact edit that would make the
    /// separation legal.
    BindingCuttableIfDeclared = "GBX0401", Binding, Info, false, "edge would be severable if declared";

    /// gRPC was requested for a severed edge, and is not available there.
    ///
    /// The consumption macro emits a REST resolving client only; there is no
    /// gRPC path. Cross-process gRPC exists in the runtime, but only through
    /// hand-written wiring.
    BindingGrpcUnsupported = "GBX0402", Binding, Warning, true, "gRPC is unavailable on a severed edge";

    /// An in-process-only contract would cross a process boundary.
    ///
    /// Only the remote-capable contract kinds may cross; the others are
    /// in-process by definition of their kind.
    BindingInProcessOnlyContract = "GBX0403", Binding, Error, true, "in-process-only contract crosses a process boundary";

    /// A consumed contract has no provider in the product.
    BindingNoProvider = "GBX0404", Binding, Error, false, "consumed contract has no provider";

    /// The provider offers no matching major version of the consumed contract.
    ///
    /// Compatibility is exact major equality: parallel majors coexist by design
    /// and there is no adapter between them.
    BindingMajorMismatch = "GBX0405", Binding, Error, false, "contract major version mismatch";

    /// The provider declares no remote-capable transport, so the edge cannot be
    /// severed.
    BindingNoRemoteTransport = "GBX0406", Binding, Warning, false, "provider declares no remote transport";

    /// The binding is local because the provider is inside the consumer's
    /// co-location closure, regardless of configuration.
    ///
    /// The runtime short-circuits to a local instance when one is present in the
    /// process, so configuring a remote endpoint here would have no effect.
    BindingForcedLocal = "GBX0407", Binding, Info, true, "binding forced local by co-location";

    /// A remote binding depends on a directory that the resolved topology does
    /// not make reachable.
    BindingDirectoryUnreachable = "GBX0408", Binding, Error, false, "directory unreachable for a remote binding";

    /// The consumer endpoint override cannot be expressed as an environment
    /// variable and must be written into configuration.
    ///
    /// The runtime's environment-key remapping converts underscores to hyphens
    /// only in the segment immediately following the gears prefix, so a
    /// hyphenated dependency name nested deeper can never be matched.
    BindingEnvCannotExpressWiring = "GBX0409", Binding, Warning, true, "endpoint override cannot come from the environment";

    /// A product preference was parsed and recorded, but the resolver does not
    /// yet honour it. Silent ignore would let an operator believe the topology
    /// changed when it did not.
    PreferenceNotHonoured = "GBX0410", Binding, Warning, false, "preference is recorded but not honoured";

    // ---------------------------------------------------------------- GBX05xx
    /// A cluster provider was selected automatically.
    ClusterAutoSelected = "GBX0501", Cluster, Info, false, "cluster provider selected automatically";

    /// No registered provider satisfies the required capabilities.
    ClusterUnsatisfiable = "GBX0502", Cluster, Error, true, "no cluster provider satisfies the required capabilities";

    /// A process-local coordination backend was selected for a topology with
    /// more than one process or replica.
    ///
    /// This is a silent correctness failure at runtime rather than a startup
    /// error: an in-memory backend starts successfully in every replica and
    /// elects one leader per replica.
    ClusterProcessLocalInMultiProcess = "GBX0503", Cluster, Error, true, "process-local cluster backend in a multi-process topology";

    /// The primitive resolved to the SDK's compare-and-swap default layered over
    /// the profile's cache, because no dedicated backend is registered for it.
    ClusterSdkDefault = "GBX0504", Cluster, Info, true, "resolved to the SDK compare-and-swap default";

    /// The named cluster provider is not registered in the runtime.
    ClusterUnregisteredProvider = "GBX0505", Cluster, Error, true, "cluster provider is not registered";

    /// The selected provider needs credentials and none were supplied.
    ClusterNoCredentialSource = "GBX0506", Cluster, Error, false, "cluster provider has no credential source";

    /// A stateful gear runs with several replicas and nothing coordinates them.
    ///
    /// Filed as a cluster concern rather than a runtime gap: the runtime is
    /// perfectly capable of leader election, so this is a statement about the
    /// product, not about a missing capability.
    ClusterStatefulReplicasWithoutElection = "GBX0507", Cluster, Warning, false, "replicated stateful gear without leader election";

    /// A cluster requirement names a profile the requiring gear does not
    /// implement.
    ///
    /// The profile is the routing key: the SDK maps it to
    /// `ClientScope::new("cluster:{name}")` and resolves whatever backend is
    /// registered there. A name nothing implements cannot be bound, so the
    /// requirement fails at startup with `ProfileNotBound` -- which is why this
    /// is caught here instead. Filed as a user error rather than a runtime gap:
    /// the runtime behaves correctly, the description is wrong.
    ClusterProfileNotImplemented = "GBX0508", Cluster, Error, false, "cluster profile is not implemented by the gear";

    /// A registered cluster provider's name or capabilities could not be read
    /// out of Rust.
    ///
    /// Reported rather than skipped. A provider missing from the catalogue would
    /// silently narrow what the resolver believes is available, turning a
    /// readable failure into an unsatisfiable-capability error somewhere else.
    ClusterProviderUnprojectable = "GBX0509", Cluster, Error, false, "cluster provider could not be projected";

    /// A plugin crate holds more than one implementation of a backend trait, so
    /// which one a provider builds cannot be determined by trait alone.
    ///
    /// Capabilities live on the backend, not the provider, and the value flow
    /// from provider to backend runs through a builder and an `Arc<dyn _>` that
    /// no source-level parse can follow. Uniqueness within the crate is what
    /// makes the backend locatable; when it does not hold, the description must
    /// narrow it explicitly.
    ClusterBackendAmbiguous = "GBX0510", Cluster, Error, false, "cluster backend implementation is ambiguous";

    /// A selected host has an extension point with no implementation selected.
    ///
    /// The host starts and then fails at the first request that needs the
    /// plugin: it queries types-registry, finds no instance for its vendor, and
    /// has nothing to route to. Whether a product tolerates that is a product
    /// decision, not a property of the gear's code, which is why there is no
    /// `optional` field on the gear side.
    PluginPointUnfilled = "GBX0511", Cluster, Error, false, "plugin extension point has no implementation";

    /// The host's effective vendor matches no selected plugin's.
    ///
    /// Both sides read `vendor` from their own config and both compile in a
    /// default, so a product that overrides one and not the other produces a
    /// host that resolves nothing -- silently, at runtime. `gears-rust` keeps
    /// this correct today with a hand-written comment in its E2E config.
    PluginVendorMismatch = "GBX0512", Cluster, Error, false, "no selected plugin matches the host's vendor";

    /// A plugin is selected but no selected gear expects its extension point.
    PluginHostNotSelected = "GBX0513", Cluster, Error, false, "plugin selected without its host";

    /// A plugin and its host were placed in different processes.
    ///
    /// A plugin registers itself with `register_scoped` into the process-local
    /// `ClientHub`, and `get_scoped` has no remote path, so the host can only
    /// find a plugin that shares its process. Neither side declares this in
    /// `deps`, which is why it has to be checked here.
    PluginNotColocated = "GBX0514", Cluster, Error, true, "plugin and host are in different processes";

    /// A gear other than the host consumes a plugin gear's contract.
    ///
    /// The Plugin Isolation Rule: plugin functionality is reachable only through
    /// the host's public API, which is what keeps implementations swappable.
    PluginIsolationViolated = "GBX0515", Cluster, Error, true, "plugin consumed directly instead of through its host";

    /// Which extension point a crate fills could not be determined.
    PluginPointUndetermined = "GBX0516", Cluster, Error, false, "plugin extension point could not be determined";

    /// Several selected plugins share a vendor for one extension point.
    ///
    /// Defined behaviour rather than a fault: the host takes the lowest
    /// `priority`. Reported so the winner is visible, because linking several
    /// implementations is legitimate -- selection may be per-tenant at runtime.
    PluginVendorAmbiguous = "GBX0517", Cluster, Info, false, "several plugins share a vendor for one extension point";

    // ---------------------------------------------------------------- GBX06xx
    /// Roles were declared. The runtime has no role concept.
    ///
    /// A worker's directory identity is a single name fixed in its binary, with
    /// no configuration override, which is exactly what role-qualified
    /// registration would require.
    GapRoles = "GBX0601", RuntimeGap, Warning, true, "roles are not supported by the runtime";

    /// Sharding or per-instance addressability was declared and cannot be
    /// realized.
    ///
    /// Instance labels exist only on the out-of-process path, selection is
    /// equality-only, and in-process gears carry no labels at all.
    GapShards = "GBX0602", RuntimeGap, Warning, true, "sharding and per-instance addressing are not supported";

    /// The Kubernetes profile resolves endpoints statically because no
    /// cluster-native endpoint resolver exists.
    GapNoK8sDnsResolver = "GBX0603", RuntimeGap, Warning, true, "no cluster-native endpoint resolver exists";

    /// Workers are local operating-system processes; no other spawn backend is
    /// implemented.
    GapNoRemoteSpawnBackend = "GBX0604", RuntimeGap, Warning, true, "only local process spawning is implemented";

    /// A registry-sourced gear was requested. Out of scope for this release.
    GapRegistrySource = "GBX0605", RuntimeGap, Error, false, "registry sources are not supported";

    /// The deployment profile is a composition-time concept, not a runtime type.
    ///
    /// It is projected onto per-gear runtime kind and deployment topology.
    GapProfileNotRuntimeType = "GBX0606", RuntimeGap, Hint, true, "deployment profile is not a runtime type";

    /// A cluster requirement was modelled as a co-location dependency because
    /// the cluster gear has no remote surface.
    ///
    /// Cluster is an in-process library today: it registers backends into the
    /// process-local `ClientHub`, and a consumer resolves them by a synchronous
    /// scoped lookup with no remote path and no fallback. A consumer must
    /// therefore be in the same process, which is what `deps = [cluster]`
    /// expresses. The decided direction is a separately deployable cluster gear,
    /// at which point the edge becomes severable -- but that design is not
    /// implemented, so this hint records the constraint rather than anticipating
    /// its removal.
    GapClusterNotDeployable = "GBX0607", RuntimeGap, Hint, true, "cluster has no remote surface, so its consumers must be co-located";

    // ---------------------------------------------------------------- GBX07xx
    /// Generation would overwrite an operator-owned file whose edits cannot be
    /// merged.
    GenClobberOperatorFile = "GBX0701", Generator, Error, false, "would overwrite operator-owned edits";

    /// A generated path escapes its output root.
    GenPathEscape = "GBX0702", Generator, Error, false, "generated path escapes the output root";

    /// Chart rendering or linting failed.
    GenHelmFailed = "GBX0703", Generator, Error, false, "chart render or lint failed";

    /// Package metadata for a gear crate could not be read.
    GenCargoMetadataFailed = "GBX0704", Generator, Error, false, "could not read package metadata";

    /// A lock resolved by an older build carries a credential.
    ///
    /// A warning, not an error: generation replaces it, so nothing it writes
    /// carries the value. What the operator must still do is re-resolve, because
    /// the lock they have keeps it until they do.
    GenLiteralSecretInLock = "GBX0705", Generator, Warning, false, "the lock carries a credential, which generation replaced";
}

/// A diagnostic code string that this build does not know.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown diagnostic code `{0}`")]
pub struct UnknownDiagnosticCode(pub String);

impl std::fmt::Display for DiagnosticCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for DiagnosticCode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for DiagnosticCode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Self::parse(&raw).map_err(serde::de::Error::custom)
    }
}

impl schemars::JsonSchema for DiagnosticCode {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Borrowed("DiagnosticCode")
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let codes: Vec<&str> = Self::ALL.iter().map(|c| c.as_str()).collect();
        schemars::json_schema!({
            "type": "string",
            "description": "stable Gearbox diagnostic code",
            "enum": codes,
        })
    }
}

/// A zero-based text position, matching Language Server Protocol semantics so it
/// can be handed to an editor without conversion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

impl Position {
    #[must_use]
    pub const fn new(line: u32, character: u32) -> Self {
        Self { line, character }
    }

    /// The start of a file, used when a diagnostic concerns a file as a whole.
    #[must_use]
    pub const fn origin() -> Self {
        Self::new(0, 0)
    }
}

/// A half-open span between two positions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

impl Range {
    #[must_use]
    pub const fn new(start: Position, end: Position) -> Self {
        Self { start, end }
    }

    /// A zero-width range at the start of a file.
    #[must_use]
    pub const fn whole_file() -> Self {
        Self::new(Position::origin(), Position::origin())
    }
}

/// Where a fact lives.
///
/// `uri` is a `file://` URI so it can be passed to an editor unchanged.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct Location {
    pub uri: String,
    pub range: Range,
}

impl Location {
    #[must_use]
    pub fn new(uri: impl Into<String>, range: Range) -> Self {
        Self {
            uri: uri.into(),
            range,
        }
    }

    /// A whole file, with no interesting span inside it.
    #[must_use]
    pub fn file(uri: impl Into<String>) -> Self {
        Self::new(uri, Range::whole_file())
    }
}

/// A `file://` URI for a path on this machine.
///
/// One function because there were five hand-rolled `format!("file://{}",
/// path.display())` calls, and `Path::display` is the wrong input for a URI on
/// Windows twice over: it yields `C:\\src\\gear.gdl`, so the result was
/// `file://C:\\src\\gear.gdl` -- backslashes a URI parser does not accept as
/// separators, and `C:` read as the *authority* rather than the path, which is
/// how an editor is handed a link to a host called `c` and opens nothing.
///
/// A leading slash is added when the path does not start with one, which is both
/// the Windows drive-letter case and the relative-path case. The relative one is
/// a lie -- `file:///product.gdl` says the file is at the filesystem root -- but
/// it is the lie that was already there, and it is the caller's business:
/// `resolve_at` exists precisely so a product's diagnostics get an absolute path
/// to build this from.
///
/// Not percent-encoded. A path with a space or a `#` in it still produces a URI
/// that is strictly invalid; encoding it is a separate change, because every
/// consumer that today compares these strings would have to be looked at.
#[must_use]
pub fn file_uri(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    }
}

/// A secondary location that helps explain a diagnostic.
///
/// Maps onto the Language Server Protocol's related-information, so an editor
/// renders these as navigable sub-entries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RelatedLocation {
    pub location: Location,
    pub message: String,
}

impl RelatedLocation {
    #[must_use]
    pub fn new(location: Location, message: impl Into<String>) -> Self {
        Self {
            location,
            message: message.into(),
        }
    }
}

/// One thing the engine has to say.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub severity: Severity,

    /// What is wrong, in one sentence, naming the specific subjects involved.
    pub message: String,

    /// Where in a file this arose, when it arose in a file at all. Resolution
    /// diagnostics often have no location and are anchored by the client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,

    /// Other places that help explain this.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<RelatedLocation>,

    /// The graph node this concerns, so a client can select it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<NodeId>,

    /// What to do about it. Required for errors
    /// (`cpt-gearbox-nfr-actionable-diagnostics`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,

    /// The `file:line` in `gears-rust` that substantiates the claim. Required
    /// for codes that assert a runtime limitation
    /// (`cpt-gearbox-nfr-evidence-cited`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

impl Diagnostic {
    /// Start a diagnostic at its code's default severity.
    #[must_use]
    pub fn new(code: DiagnosticCode, message: impl Into<String>) -> Self {
        Self {
            code,
            severity: code.default_severity(),
            message: message.into(),
            location: None,
            related: Vec::new(),
            subject: None,
            help: None,
            evidence: None,
        }
    }

    /// Start an error, which must carry a remedy.
    ///
    /// Taking `help` as a parameter rather than a builder step is deliberate:
    /// it makes an actionless error impossible to write.
    #[must_use]
    pub fn error(
        code: DiagnosticCode,
        message: impl Into<String>,
        help: impl Into<String>,
    ) -> Self {
        Self::new(code, message)
            .with_severity(Severity::Error)
            .with_help(help)
    }

    #[must_use]
    pub fn with_severity(mut self, severity: Severity) -> Self {
        self.severity = severity;
        self
    }

    #[must_use]
    pub fn at(mut self, location: Location) -> Self {
        self.location = Some(location);
        self
    }

    #[must_use]
    pub fn with_related(mut self, related: RelatedLocation) -> Self {
        self.related.push(related);
        self
    }

    #[must_use]
    pub fn about(mut self, subject: NodeId) -> Self {
        self.subject = Some(subject);
        self
    }

    #[must_use]
    pub fn with_help(mut self, help: impl Into<String>) -> Self {
        self.help = Some(help.into());
        self
    }

    /// Cite the source that proves the claim, as `path:line`.
    #[must_use]
    pub fn with_evidence(mut self, evidence: impl Into<String>) -> Self {
        self.evidence = Some(evidence.into());
        self
    }

    #[must_use]
    pub const fn is_error(&self) -> bool {
        self.severity.is_error()
    }

    /// Check the invariants the PRD requires of every diagnostic.
    ///
    /// Called by a test over the whole emitted set rather than on every
    /// construction, so a violation is a build failure rather than a runtime
    /// panic in front of a user.
    ///
    /// # Errors
    /// Returns a description of each violated invariant.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut problems = Vec::new();

        if self.message.trim().is_empty() {
            problems.push(format!("{}: message is empty", self.code));
        }
        if self.is_error() && self.help.as_ref().is_none_or(|h| h.trim().is_empty()) {
            problems.push(format!(
                "{}: error severity requires a remedy (cpt-gearbox-nfr-actionable-diagnostics)",
                self.code
            ));
        }
        if self.code.requires_evidence()
            && self.evidence.as_ref().is_none_or(|e| e.trim().is_empty())
        {
            problems.push(format!(
                "{}: asserts a runtime limitation and requires cited evidence \
                 (cpt-gearbox-nfr-evidence-cited)",
                self.code
            ));
        }

        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems)
        }
    }
}

/// A set of diagnostics, kept in a stable order.
///
/// Ordering is by `(code, message)` rather than emission order, so the same
/// resolution always yields the same sequence regardless of internal iteration
/// (`cpt-gearbox-nfr-determinism`).
#[derive(Clone, Debug, Default, PartialEq, Eq, TS)]
pub struct Diagnostics(Vec<Diagnostic>);

impl Serialize for Diagnostics {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

impl<'de> Deserialize<'de> for Diagnostics {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Vec::<Diagnostic>::deserialize(d).map(Self)
    }
}

impl Diagnostics {
    #[must_use]
    pub const fn new() -> Self {
        Self(Vec::new())
    }

    pub fn push(&mut self, diagnostic: Diagnostic) {
        self.0.push(diagnostic);
    }

    pub fn extend(&mut self, other: impl IntoIterator<Item = Diagnostic>) {
        self.0.extend(other);
    }

    /// Sort into canonical order and drop exact duplicates.
    ///
    /// Duplicates are expected: the same structural fact is often reached from
    /// several directions during resolution.
    pub fn finish(&mut self) {
        self.0.sort_by(|a, b| {
            a.code
                .cmp(&b.code)
                .then_with(|| a.message.cmp(&b.message))
                .then_with(|| a.location.cmp(&b.location))
        });
        self.0.dedup();
    }

    #[must_use]
    pub fn has_errors(&self) -> bool {
        self.0.iter().any(Diagnostic::is_error)
    }

    pub fn errors(&self) -> impl Iterator<Item = &Diagnostic> {
        self.0.iter().filter(|d| d.is_error())
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub fn as_slice(&self) -> &[Diagnostic] {
        &self.0
    }

    pub fn iter(&self) -> std::slice::Iter<'_, Diagnostic> {
        self.0.iter()
    }

    /// Highest severity present, if any.
    #[must_use]
    pub fn max_severity(&self) -> Option<Severity> {
        self.0.iter().map(|d| d.severity).max()
    }
}

impl FromIterator<Diagnostic> for Diagnostics {
    fn from_iter<I: IntoIterator<Item = Diagnostic>>(iter: I) -> Self {
        Self(iter.into_iter().collect())
    }
}

impl IntoIterator for Diagnostics {
    type Item = Diagnostic;
    type IntoIter = std::vec::IntoIter<Diagnostic>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl<'a> IntoIterator for &'a Diagnostics {
    type Item = &'a Diagnostic;
    type IntoIter = std::slice::Iter<'a, Diagnostic>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}
