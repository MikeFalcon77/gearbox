# Gearbox Builder — Prototype

## Context

`docs/gearbox-builder-vision.md` (127 sections) proposes a product-composition layer for the
Gears platform: `gear.gdl` + `product.gdl` → Starlark evaluation → typed Rust IR → deterministic
resolver → `product.lock` → generators (Cargo crates, Docker, Helm), with CLI/GUI/MCP as clients
of one engine. It is a vision doc: nothing is built, and its examples reference runtime features
that do not exist.

This plan builds a **working vertical slice** of that architecture, with one hard rule: **GDL may
only express what `gears-rust` actually implements today.** Everything the vision assumes but the
runtime lacks (roles, shards, per-instance addressability, Redis/K8s-Lease providers, a K8s
EndpointResolver, deployment profiles as a runtime type) is either rejected or downgraded to an
explicit diagnostic carrying a `file:line` citation — never silently faked.

The prototype proves the vision's central promise end to end: **one gear source, three deployment
topologies, zero changes to business code** — and it produces the artefacts that make "gear = pod"
possible at all (generated process crates), which is the real blocker today, not runtime support.

Repo state: `gearbox-builder` is `cargo new` plus the vision doc. `gears-rust` and `cargo-gears`
exist locally and were surveyed; `cargo-gears/design/ideas/gears-product-configurator-OLD.md` is
the repo-grounded predecessor and its conclusions are folded in below.

### Decisions taken with the user
- **RPC:** JSON-RPC 2.0 over stdio with LSP `Content-Length` framing → `vscode-jsonrpc` works with
  zero adapter code in Theia, no ports/CORS/auth, and the same server backs the `.gdl` language client.
- **Scope:** full pipeline — resolve → lock → process crates that `cargo build` → Dockerfile → Helm
  umbrella + `values.schema.json`.
- **Slice:** real gears from `gears-rust` + one new custom gear (vision §81's canonical acceptance test).
- **Theia:** a runnable Gearbox Studio in this repo — extension + `browser-app` + `electron-app`.
- **Layout:** engine lives in `gearbox-builder`; `gear.gdl` files are added to `gears-rust` next to
  the real gears (additive only).
- **Build clean:** no dependency on `cargo-gears` crates; port templates by hand.
- **`gear.gdl` is the single source of truth**, with `gearbox validate` cross-checking it against the
  real Rust attributes via `syn`.
- **CLI is a standalone `gearbox` binary**, not `cargo gears` (departs from vision §4/§97–99;
  matches the decision already recorded for the ConstructorFabric deck).
- **Spec artefacts:** a short **PRD now** (before code), the prototype as the spike, then a
  **DESIGN + ADRs grounded in what actually worked** — see §14. All in `gearbox-builder/docs/`,
  following the `gears-rust/docs/spec-templates/gears-sdlc/` templates.
- No CI.

This plan is also copied to `docs/plans/gearbox-builder-prototype.md` as the first commit.

---

## 1. Grounded reality — what constrains the GDL

Verified against `gears-rust` (all claims spot-checked in source):

| Fact | Evidence | Consequence for GDL |
|---|---|---|
| No gear manifest exists. Gear metadata lives **only** in `#[toolkit::gear(name, deps, capabilities, ctor, client, lifecycle)]` | `libs/toolkit-macros/src/lib.rs` | `gear.gdl` is genuinely new information, not a re-encoding |
| `capabilities` is a **closed set of 7**: `db, rest, rest_host, stateful, system, grpc_hub, grpc` | same, `Capability` enum | GDL exposes exactly these, nothing more |
| **`deps` means link-time co-location** — the macro emits `pub use ::crate as _gear_dep_x` to keep `inventory::submit!` alive | same | must be named so it can't be confused with contract consumption |
| **Missing deps are a hard error**, so co-location is a *downward closure, not a partition* — `types-registry` is linked into every process whose closure names it, and two anchors sharing a dep do **not** merge | `RegistryError::MissingDeps`, `libs/toolkit/src/registry.rs:589` | processes **overlap**; the resolver must model that, and `deps` edges are **never cuttable** |
| Contract kind is the **trait-name suffix**: `…Api` / `…Embedded` / `…Backend` / `…Extension`; only `Api`\|`Backend` are remote-capable | `libs/toolkit-contract/src/descriptor.rs` | placement constraint is derivable statically |
| Contract version is real: `#[toolkit::contract(gear, version)]`, trailing major on the name must agree, parallel majors coexist | `toolkit-contract-macros/src/parse.rs:80-97` | version-mismatch check works without cargo metadata |
| **`#[toolkit::consumes]` emits a REST resolving client only** — `{Contract}RestResolvingClient` is hardcoded, no gRPC branch | `consumes.rs:166` | `transport = grpc` on a cut edge is **unsupported** |
| `consumes` derives `owner_gear` from **kebab of the struct ident**, not from `gear(name=)`; mismatch only `warn!`s | `consumes.rs` module docs | first-class `validate` check — a mismatch silently breaks `consumer_wiring` |
| `consumes` injects **no** topo dep | same | remote providers need not be in the local registry |
| `WireOutcome::{Local,Remote}`; `try_get_local` short-circuits (no readiness gate), else `register_remote_proxy` + `EndpointResolver` gates `/readyz` | `libs/toolkit/src/discovery.rs`, `host_runtime.rs:546-554` | local-vs-remote is genuinely *derived* from placement |
| `EndpointResolver` impls: `Directory` (gRPC), `Static` (config), `Null`. **No K8s-DNS resolver** | `discovery.rs` | k8s profile must use `Static` and say so |
| `ClientWiring::{Local, Rest{endpoint,tuning}, Grpc{endpoint,tuning}}`; key `gears.<gear>.config.client_wiring.<contract_snake>`; absent ⇒ Local | `toolkit-contract/src/wiring.rs` | transports are exactly `{local, rest, grpc}` |
| Deployment profiles are **prose only** — `grep HostWorkers --include=*.rs` = 0 hits; `DESIGN.md:230` has an unchecked box. What exists is per-gear `RuntimeKind::{Local,Oop}` + `ExecutionConfig` | `bootstrap/config/mod.rs:86-93` | profile is a *Gearbox* concept projected onto per-gear runtime + topology |
| Only `LocalProcessBackend` is implemented; `BackendKind::{K8s,Static,Mock}` are bare variants | `libs/toolkit/src/backends/mod.rs:12-19` | host-workers = one machine, full stop |
| Cluster registry is **hardcoded Rust**: cache `{standalone, postgres}`, lock `{postgres}`, leader-election `{}` (always SDK CAS default) | `gears/system/cluster/cluster/src/gear.rs:47-53` | no Redis/etcd/NATS/K8s-Lease. Codegen must emit Rust, not just YAML |
| Cache capability matrix is **asymmetric**: `standalone` → linearizable ✔ prefix_watch ✔ but process-local; `postgres` → linearizable ✔ prefix_watch ✘ | `CacheFeatures::new(true)` in standalone `cache.rs:281`; `new(false)` in postgres `cache/mod.rs:174` | `cache(linearizable + prefix_watch)` is **unsatisfiable multi-process** — the best real capability demo in the repo |
| **No `role` concept.** OoP directory identity is `OopServeOptions.gear_name`, hardcoded per binary, no config override. Labels exist for OoP only, equality-AND only | `bootstrap/oop.rs`, `system-sdks/.../labels.rs` | roles/shards ⇒ diagnostic, excluded from resolution |
| `gears.<c>.config.consumer_wiring.<dep>` **cannot** be set via `APP__` env — `remap_gear_env_key` remaps `_`→`-` only in the segment right after `gears` | `config/mod.rs:429` | Helm must put consumer wiring in the **ConfigMap**, never env |
| `registered_gears.rs` is real and load-bearing; its own header asks for a generator | `apps/cf-gears-example-server/src/registered_gears.rs` | exactly what we generate |
| `--list-gears`, `--dump-gears-config-yaml/json` exist on the example server | `apps/cf-gears-example-server/src/main.rs` | use as lock-file **verification oracles** |
| `cf-api-contracts` has **no `[lib]` section** ⇒ lib ident is `cf_api_contracts` | its `Cargo.toml` | lib ident must be **declared** in `gear.gdl`, never derived from the crate name |
| Only one Helm chart in the repo (mini-chat), hand-written | `gears/mini-chat/deploy/helm/mini-chat/` | golden reference for the Helm generator |

Also: `make oop-example` is stale (`--features oop_gear` doesn't exist), so the Profile-2 baseline
must be re-established by hand before any generated output is trusted.

---

## 2. Architecture

### 2.1 Rust workspace

Replace the single-package `Cargo.toml` with a virtual workspace. Add `rust-toolchain.toml`
pinning `1.97.0` to match `gears-rust` (local is 1.96.0 — `rustup toolchain install 1.97.0` first).

```
gearbox-builder/
  Cargo.toml              # [workspace] members = ["crates/*"]
  rust-toolchain.toml     # 1.97.0
  crates/
    gearbox-ir/           # canonical typed model + IDs + diagnostics. Pure data.
    gearbox-gdl/          # Starlark host → IR. The only crate naming `starlark::`.
    gearbox-lock/         # canonical product.lock read/write + lock_hash + diff
    gearbox-verify/       # syn scan of gear crates, cross-check vs gear.gdl
    gearbox-resolve/      # deterministic resolver + explanation graph. Pure fn.
    gearbox-gen/          # artefact emission → FileSet. Never touches the FS.
    gearbox-engine/       # facade; the ONLY crate doing filesystem/process I/O
    gearbox-rpc/          # JSON-RPC over stdio, LSP framing
    gearbox-cli/          # [[bin]] name = "gearbox"
  templates/              # minijinja sources, include_str!
  products/payments-demo/product.gdl
  fixtures/               # golden locks, effective-config dumps, rpc-schema.json
  ide/                    # npm workspaces (§6)
```

Dependency DAG is strictly layered: `ir` ← {`gdl`, `lock`, `verify`, `resolve`, `gen`} ←
`engine` ← {`rpc`, `cli`}. **Boundary guarantee (vision §7):** a test in
`gearbox-engine/tests/no_frontend_deps.rs` runs `cargo metadata --no-deps` and asserts the
engine's dependency set names no CLI/RPC/UI crate.

Pinned deps: `starlark` + `starlark_syntax` (pin the exact minor — pre-1.0, the `Dialect` and
`#[starlark_module]` surface moves), `minijinja` 2 (`custom_syntax`), `syn` 2 (`full`,
`extra-traits`, `visit`), `toml` 0.9, `serde-saphyr` (same YAML crate the runtime deserializes
with — round-trip fidelity for free), `schemars` 1.2, `ts-rs` 11, `blake3`, `petgraph`, `heck`.

### 2.2 Key design rules carried from the vision
- **Template text. Serialize data.** minijinja for Rust/Dockerfile/NOTES.txt; **serde only** for
  `product.lock`, `values*.yaml`, `values.schema.json`, `Chart.yaml`. A test enforces that no
  generator ever templates a YAML *structure*.
- **Helm delimiter collision:** minijinja for Helm template bodies uses `<< >>` / `<% %>` / `<# #>`
  so Helm's `{{ }}` passes through untouched.
- **`selected` vs `resolved`** is a generic `Selected<T> { selected: Choice<T>, downgraded_by:
  Option<DiagnosticCode> }` next to every derived value.
- **Provenance is built during resolution**, never reconstructed. Node ids are content-derived
  (`decision:cut:{consumer}->{provider}`), never counters, so the graph is byte-stable.

---

## 3. GDL surface

### 3.1 Host API (globals; no `load()` needed for the vocabulary)

Functions: `gear`, `product`, `cargo`, `provide`, `consume`, `rest`, `grpc`, `lifecycle`,
`endpoint`, `provider`, `cluster_profile`, `use_gear`, `source`/`path`/`git`/`registry`,
`embedded`/`host_workers`/`kubernetes`, `bind`, `process`, `fail`.

Frozen namespaces (a typo is an `AttributeError` at eval time, not a silently-null string):
- `cap.{db,rest,rest_host,stateful,system,grpc_hub,grpc}` — the closed 7
- `transport.{local,rest,grpc}`
- `contract_kind.{api,embedded,backend,extension}`
- `cluster.{cache,leader_election,lock}` — the only three primitives that exist
- `cluster_cap.{linearizable,prefix_watch}`
- `binding_mode.{auto,local,remote}`
- `prefer.{existing_infrastructure,fewer_processes,isolate}`

`print` is overridden to emit a `Hint` diagnostic — **stdout is the RPC channel and nothing else
may write to it.**

### 3.2 Keeping GDL declarative (vision §12) — three layers

1. **Dialect lockdown:** `enable_def: false`, `enable_lambda: false`, `enable_top_level_stmt: false`,
   `enable_f_strings: false`, `enable_types: Disable`, `enable_load: true`, `enable_load_reexport: false`.
2. **Token blacklist** (this is the enforcement that actually matters — comprehensions and ternaries
   are legal in the dialect): lex with `starlark_syntax::lexer::Lexer` before parsing and reject
   `if elif else for while def lambda not and or in` → **GBX0103** with the exact span.
3. **No mutable host state and no readable inputs:** globals are frozen; `gear()`/`product()` write
   once into `Evaluator::extra` (second call = GBX0105). No host function exposes the deployment
   profile, environment, clock, or filesystem — so a script *cannot* branch on resolution inputs
   even if it could branch.

`load()`: a `FileLoader` restricted to relative paths inside the declaring file's source root,
rejecting `..` escapes (GBX0104), memoizing frozen modules by canonical path. Loaded fragments may
contain assignments only.

### 3.3 Rejected / downgraded vision constructs

| Construct | Verdict | Behaviour |
|---|---|---|
| `role(...)`, `sharded`, `instance_addressable` | **Downgraded** | parsed into `declared_roles` for forward-compat, **excluded from resolution**; GBX0601/0602 `Warning` citing `bootstrap/oop.rs` |
| `provider("redis"\|"k8s-lease"\|"etcd"\|"nats")` | **Rejected** | GBX0505 `Error` listing the actual registry contents |
| `registry(package, version)` source | **Rejected** | GBX0605 — use `path()` or `git()` |
| `transport.grpc` on a cut edge | **Downgraded** | GBX0402 `Warning`, forced to `rest` |
| `kind = service()` / plugin model | **Deferred** | unknown kwarg (GBX0106) — no runtime concept behind it |
| Deployment profile as a runtime type | **Reframed** | GBX0606 `Hint` once per resolve |

### 3.4 Representative `gear.gdl` — the new custom gear

`gears-rust/gears/payments-audit/payments-audit/gear.gdl`:

```python
AUDIT_SDK   = cargo(crate = "cf-gears-payments-audit-sdk", lib = "payments_audit_sdk",
                    path = "../payments-audit-sdk", features = ["rest-client"])
PAYMENT_SDK = cargo(crate = "cf-api-contracts-sdk", lib = "api_contracts_sdk",
                    path = "../../../examples/toolkit/api-contracts/api-contracts-sdk",
                    features = ["rest-client"])

gear(
    id = "payments-audit",
    name = "Payments Audit",
    description = "Cluster-cached audit trail; the elected leader reconciles it periodically.",
    category = "example",
    visibility = "public",

    # lib is MANDATORY, never derived — cf-api-contracts has no [lib] section.
    package = cargo(crate = "cf-gears-payments-audit", lib = "payments_audit",
                    path = ".", link = ["payments_audit"]),

    # 1:1 with #[toolkit::gear(capabilities = [...])]. Closed set of 7.
    runtime_caps = [cap.rest, cap.stateful],

    # 1:1 with #[toolkit::gear(deps = [...])]. LINK-TIME CO-LOCATION: the macro
    # emits `pub use ::cluster as _gear_dep_0`, so the crate is physically in the
    # binary and a missing dep is RegistryError::MissingDeps. NEVER cut.
    colocated_deps = ["cluster"],

    lifecycle = lifecycle(entry = "serve", stop_timeout = "15s"),

    provides = [
        provide(contract = "PaymentsAuditApi", version = "v1", kind = contract_kind.api,
                rust = "payments_audit_sdk::PaymentsAuditApi", sdk = AUDIT_SDK,
                local = "Self::build_local",
                transports = [transport.local, transport.rest],
                rest = rest(base_path = "/api/v1/payments-audit")),
    ],

    # Remote-capable + declared => the resolver MAY cut this edge.
    consumes = [
        consume(contract = "PaymentApi", version = "v1", kind = contract_kind.api,
                rust = "api_contracts_sdk::PaymentApi", sdk = PAYMENT_SDK,
                from_ = "api-contracts", critical = False),
    ],

    requires = [
        cluster.cache(profile = "default", capabilities = [cluster_cap.linearizable]),
        cluster.leader_election(profile = "default"),
    ],

    serves = [endpoint(name = "rest", via = "rest_host")],
)
```

The `cluster` gear's `gear.gdl` additionally declares `cluster_providers = [provider("standalone",
primitives=["cache"]), provider("postgres", primitives=["cache","lock"])]` — mirroring
`ClusterGear::provider_registry()`. `gearbox validate` diffs the two; a new `with_*_provider` line
in Rust that isn't listed is **GBX0204**, so the resolver's capability table cannot rot.

### 3.5 `product.gdl`

`gearbox-builder/products/payments-demo/product.gdl` — all three profiles declared as **data**,
selected by `gearbox resolve --profile <id>`. No `if` anywhere; profile-scoping is a
`profiles = [...]` list field on `bind`/`cluster_profile`/`process`.

```python
product(
    id = "payments-demo", name = "Payments Demo", version = "0.1.0",
    sources = [source(id = "gears-rust", at = path("../../../gears-rust"))],
    profiles = [
        embedded(id = "dev"),
        host_workers(id = "local", host = "gateway", worker_discovery = "directory",
                     target_dir = "../../../gears-rust/target"),
        kubernetes(id = "prod", discovery = "static", namespace = "payments",
                   image_registry = "registry.example.com/payments"),
    ],
    default_profile = "dev",
    gears = [ use_gear("api-gateway", source = "gears-rust"),
              use_gear("gear-orchestrator", source = "gears-rust"),
              use_gear("api-contracts", source = "gears-rust"),
              use_gear("api-contracts-consumer", source = "gears-rust"),
              use_gear("payments-audit", source = "gears-rust") ],
    bindings = [
        bind(consumer = "payments-audit", contract = "api-contracts/PaymentApi@v1",
             mode = binding_mode.remote, transport = transport.rest,
             profiles = ["local", "prod"]),
    ],
    cluster_profiles = [
        cluster_profile(name = "default", cache = provider("standalone"), profiles = ["dev"]),
        cluster_profile(name = "default", profiles = ["local", "prod"],
            cache = provider("postgres",
                connection_string = "postgres://payments@${PG_HOST}:5432/payments?password=${PG_PASSWORD}",
                schema = "cluster", pool_max_size = 10)),
    ],
    processes = [process("audit", anchor = "payments-audit", replicas = 2, profiles = ["prod"])],
    preferences = [prefer.existing_infrastructure(), prefer.fewer_processes()],
)
```

Note what it does **not** list: `grpc-hub`, `authn-resolver`, `types-registry`, `cluster` — they
arrive via `colocated_deps` closure, which is exactly the fact the Graph widget makes visible.

---

## 4. Typed IR (`crates/gearbox-ir/`)

Every public type derives `Serialize, Deserialize, TS, JsonSchema`. Stable-ID newtypes with
validating constructors as the single validation point:

| Newtype | Format |
|---|---|
| `GearId` | `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` — exactly `toolkit-macros::validate_kebab_case` |
| `ContractId` | `{gear}/{BaseTraitName}@v{major}` — e.g. `api-contracts/PaymentApi@v1` (Rust's trailing major is stripped, so v1/v2 are one family) |
| `ProcessId` | kebab; derived from the anchor `GearId`, `-2`/`-3` on collision |
| `ProviderId` | `{primitive}:{provider}` |
| `RequirementId` | `{gear}#{namespace}[{ordinal}]` |
| `CapabilityId` | `{namespace}.{name}` — e.g. `cluster.cache.linearizable` |
| `NodeId` | `{kind}:{payload}` — content-derived, never a counter |

Core shapes (full definitions in implementation):

- `Catalogue { gears: BTreeMap<GearId, GearDescriptor>, contracts, sources, diagnostics }`
- `GearDescriptor { id, display_name, visibility, source, gdl_path, package: CargoRef,
  runtime_caps: BTreeSet<RuntimeCap>, colocated_deps: BTreeSet<GearId>, lifecycle, provides,
  consumes, requires, serves, client_trait, cluster_providers, declared_roles, config_schema }`
- `CargoRef { crate_name, lib_ident /* MANDATORY */, path, features, default_features, link }`
  — `link` is the `use X as _;` idents, allowing nested plugin module paths.
- `RuntimeCap { Db, Rest, RestHost, Stateful, System, GrpcHub, Grpc }` — closed.
- `ContractKind { Api, Embedded, Backend, Extension }` with `provides()`, `requires()`,
  `remote_capable()` (= `Api | Backend`); `remote_capable == false` is the placement constraint.
- `RequirementKind::{ Contract { contract, from, resolving_client }, Cluster { primitive, profile } }`
- `ResolvedProduct { schema_version, product, sources, gears, processes, bindings, cluster,
  cuttable_if_declared: Vec<CutCandidate>, provenance }`
- `ResolvedProcess { name, kind: Host|Worker, anchor /* == OopRunOptions.gear_name for workers */,
  gears /* topo-sorted, MAY OVERLAP other processes */, replicas, entrypoint, bin_name,
  crate_name, listens, rest_host, grpc_hub, needs_db, spawns }`
- `ResolvedBinding { consumer, consumer_process, contract, provider, provider_process, mode,
  transport, mechanism, endpoint_source, endpoint, critical, selected: Selected<_> }`
- `BindingMechanism { ColocatedLocal, ConsumesStatic, ConsumesDirectory, ProvidesClientWiring }`
  — names the *actual code path*, not an abstraction.
- `ClusterResolution::{ Provider { name }, SdkCasDefault { over_cache } }`
- `CutCandidate { consumer, provider, contract, blocked_by: CutBlocker, suggested_edit, file,
  estimated_savings }` with `CutBlocker { ColocationClosure, UndeclaredHubEdge,
  InProcessOnlyContract, NoRemoteTransport, ProfileForbidsSplit }`
- `Diagnostic { code, severity, message, location /* LSP-shaped */, related, subject: NodeId,
  help, evidence /* real file:line in gears-rust */ }`
- `ExplanationGraph { nodes, edges: Vec<ProvenanceEdge> }` with `ProvenanceKind { Declared,
  ColocatedBy, SelectedBy, DerivedFrom, ConstrainedBy, PreferredOver, DowngradedBy, Diagnosed }`

---

## 5. Resolver

`Resolver::resolve(&Catalogue, &ProductIntent, ProfileId) -> Resolution`. Pure — no I/O, clock, or
env. Deterministic by construction: iterate `BTreeMap`/`BTreeSet` only; sort every output `Vec` by
its ID tuple; ties break lexicographically.

1. **Profile projection.** Filter `bindings`/`cluster_profiles`/`process_pins` by
   `profiles.is_empty() || contains(profile)`. Duplicate matching keys → GBX0110.
2. **Closure.** BFS from `selected_gears` over `colocated_deps` (deterministic pop order).
   Unknown gear → GBX0301; cycle → GBX0302.
3. **Cut-candidate classification.** Per `consumes` requirement: no provider → GBX0404; major
   mismatch → GBX0405 (**exact major equality**, no widening — parallel majors are by design and
   there is no adapter); `!remote_capable` → not cuttable + GBX0403 error; provider ∈ closure →
   not cuttable + GBX0407 (`try_get_local` wins regardless of config); no `transport.rest` →
   GBX0406. Otherwise cuttable.
   Separately, the **"edges I would cut if declared"** report: for every `(c, p)` where `p ∉
   closure(c)`, there is no `consumes` edge, but `p` provides a remote-capable contract — record
   `UndeclaredHubEdge` with the literal `#[toolkit::consumes(...)]` line to add and its file.
   **Never cut** (direct `hub.get::<dyn X>()` is common and splitting breaks at runtime). GBX0401.
   *This report is a deliverable, not a limitation.*
4. **Process partition.** `Embedded` → exactly one process (anchor = the unique `rest_host` gear);
   any split request or `replicas > 1` → GBX0307 + downgrade. `HostWorkers`/`Kubernetes` → anchors
   = host ∪ chosen-cut providers ∪ pins; **one deterministic pass** over cut candidates (no scoring,
   no search — vision §41); `P(a).gears = topo_sort(closure(a))`, so processes **overlap**.
5. **Structural checks.** >1 `rest_host`/`grpc_hub` per process → GBX0303/0304 (mirrors
   `registry.rs`); `rest_host` inside a Worker → GBX0312 (workers serve via `oop_serve`'s own
   router); Directory discovery without `gear-orchestrator` → GBX0308 and without `grpc-hub` →
   GBX0309 (`run_oop_spawn_phase` blocks on `wait_for_grpc_hub_endpoint()`); missing `target_dir` →
   GBX0310; orphan gear → GBX0311. `HostWorkers` always emits GBX0604 (local OS processes only).
6. **Binding derivation.** Same process ⇒ `Local` / `ColocatedLocal` / no endpoint. Different ⇒
   `Remote`; transport priority: explicit-and-supported → gRPC requested (GBX0402, downgrade to
   REST) → provider ∩ `{Rest}` → else GBX0406 and revert to Local by merging the processes.
   Mechanism `ConsumesStatic` or `ConsumesDirectory` per profile discovery. Env-only wiring request
   → GBX0409 (`remap_gear_env_key` cannot express it).
7. **Cluster matching** over exactly `{standalone, postgres}` + SDK CAS defaults. Table-driven from
   `ClusterProviderDecl.capabilities`, cross-checked against Rust by `gearbox-verify`. Auto ranking:
   (a) `prefer.existing_infrastructure` favours a provider already bound for another primitive,
   (b) multi-process-capable first when >1 process or any replicas>1, (c) lexicographic. No
   candidate + cache bound ⇒ `SdkCasDefault` (GBX0504) — which is *always* the leader-election
   answer, since zero LE providers are registered. Then the hard guard: a **process-local** provider
   with >1 process or replicas>1 → **GBX0503 `Error`** ("`standalone` cache is in-memory and
   per-process; leader election over it elects a leader per replica"). This catches a silent
   correctness bug the runtime would happily start with — the single most valuable diagnostic here.
8. **`stateful` + replicas without leader election** → GBX0507 `Warning`.
9. **Explanation graph** — every decision pushes its node + provenance edges at the moment it is made.
10. **Canonical ordering + `lock_hash`** = `blake3(canonical TOML with lock_hash elided)`.

`Error` diagnostics do **not** abort resolution — a best-effort product plus errors lets the UI
render a partial graph. `gearbox-engine` refuses to *write* the lock or generate when any `Error`
is present, unless `--allow-errors`.

Diagnostic ranges: `GBX01xx` GDL, `GBX02xx` validate cross-check, `GBX03xx` topology,
`GBX04xx` binding, `GBX05xx` cluster, `GBX06xx` runtime gaps, `GBX07xx` generators.

---

## 6. `product.lock`

`toml` 0.9 serialization of `ResolvedProduct`, arrays-of-tables in sorted order, two-line generated
header, no other comments. Written only by `gearbox-lock::write_canonical`.

```toml
# GENERATED by gearbox 0.1.0 — do not edit. Run `gearbox resolve` to regenerate.
schema_version = 1

[product]
id = "payments-demo"; version = "0.1.0"; profile = "local"
profile_kind = "host-workers"; gearbox_version = "0.1.0"; lock_hash = "blake3:…"

[sources.gears-rust]
kind = "path"; location = "../../../gears-rust"; digest = "git:8f3c1a9b…"

[gears.payments-audit]
source = "gears-rust"
gdl_path = "gears/payments-audit/payments-audit/gear.gdl"
crate_name = "cf-gears-payments-audit"; lib_ident = "payments_audit"
crate_path = "gears/payments-audit/payments-audit"; link = ["payments_audit"]
runtime_caps = ["rest", "stateful"]; colocated_deps = ["cluster"]
selected_by = ["product.gdl:use_gear"]
# … one table per gear in the closure; `selected_by` records WHY it is here,
#   e.g. selected_by = ["colocated_deps:api-gateway"] for grpc-hub

[[process]]
name = "gateway"; kind = "host"; anchor = "api-gateway"
gears = ["types-registry","authn-resolver","grpc-hub","api-gateway",
         "api-contracts","api-contracts-consumer","gear-orchestrator"]
replicas = 1; entrypoint = "run_server"
bin_name = "gbx-gateway"; crate_name = "gbx-payments-demo-gateway"
rest_host = "api-gateway"; grpc_hub = "grpc-hub"; needs_db = false

[[process.spawns]]                     # mirrors config/oop-example-master+follower.yaml
gear = "payments-audit"
executable_path = "../../../gears-rust/target/debug/gbx-payments-audit"
args = ["--config", "config/payments-audit.yaml"]

[[process]]
name = "payments-audit"; kind = "worker"
anchor = "payments-audit"              # == OopRunOptions.gear_name, the directory identity
gears = ["cluster", "payments-audit"]  # `cluster` linked here, NOT in gateway
replicas = 1; entrypoint = "run_oop_with_options"; bin_name = "gbx-payments-audit"

[[binding]]
consumer = "payments-audit"; consumer_process = "payments-audit"
contract = "api-contracts/PaymentApi@v1"
provider = "api-contracts"; provider_process = "gateway"
mode = "remote"                        # DERIVED from placement, never configured
transport = "rest"; mechanism = "consumes-directory"
endpoint_source = "directory:gear-orchestrator/api-contracts"
critical = false; selected = "explicit:remote/rest"

[[cluster]]
profile = "default"; primitive = "leader_election"
requesters = ["payments-audit"]; selected = "auto"
resolved = { via = "sdk-cas-default", over_cache = "postgres" }
diagnostics = ["GBX0504"]

[[cuttable_if_declared]]
consumer = "api-contracts-consumer"; provider = "payments-audit"
blocked_by = "undeclared-hub-edge"
suggested_edit = "#[toolkit::consumes(contract = payments_audit_sdk::PaymentsAuditApi, from = \"payments-audit\")]"
file = "examples/toolkit/api-contracts/api-contracts-consumer/src/gear.rs"
```

`dev` differs by having one process with all nine gears and all bindings `mode = "local"`.
`prod` adds `[product.kubernetes]`, per-process `image`/`subchart`/`service_port`,
`mechanism = "consumes-static"` with a `{{ .Release.Name }}`-templated endpoint, and GBX0603.

---

## 7. Generators

Every generator returns a `FileSet` of `FileEntry { path, bytes, kind, ownership }`.
`gearbox-engine::apply_generate` is the only writer: `Generated` → overwrite; `GeneratedOnce` →
write if absent; `OperatorOwned` → 3-way merge against a base cached in `.gearbox/<product>/.base/`
using `similar`, conflict → GBX0701 and leave the file untouched. Output root
`.gearbox/<product>/<profile>/`. **Nothing is ever written into `gears-rust`.**

| Output | Mechanism | Golden reference |
|---|---|---|
| Generated workspace + `rust-toolchain.toml` | serde | `gears-rust/rust-toolchain.toml` |
| `processes/<p>/Cargo.toml` | serde | `examples/oop-gears/calculator/calculator/Cargo.toml` |
| Host `src/main.rs` | minijinja `{{ }}` | `examples/toolkit/users-info/users-info-server/src/main.rs` |
| Worker `src/main.rs` | minijinja | `examples/oop-gears/calculator/calculator/src/main.rs` |
| `src/registered_gears.rs` | minijinja | `apps/cf-gears-example-server/src/registered_gears.rs` |
| `config/<p>.yaml` (AppConfig) | **serde → `serde_saphyr`** | `config/oop-example-master+follower.yaml` |
| `docker/<p>.Dockerfile` + `build.sh` + `.dockerignore` | minijinja `{{ }}` | `gears/mini-chat/deploy/docker/mini-chat.Dockerfile` |
| Helm umbrella + subcharts | Chart/values via **serde**; template bodies via minijinja `<< >>` | `gears/mini-chat/deploy/helm/mini-chat/` |
| `product.lock`, `explain.json` | serde | — |

**Generated host `main.rs`** mirrors the users-info shape and adds the oracle flags
(`--list-gears`, `--dump-gears-config-yaml/json`) plus one new one:
`--list-registered-gears`, which prints `GearRegistry::discover_and_build()`'s real
inventory-discovered topo order and real `deps` as `<name>\t<dep>,<dep>` lines. This is the
strongest available verification oracle — diff it against the lock's `process.gears`.

**Generated `registered_gears.rs`** emits one `use <ident> as _;` per `CargoRef.link` entry (so
nested plugin modules work) and **no `#[cfg(feature)]` gates** — the generated `Cargo.toml`'s
dependency set *is* the feature switch. Validation is therefore semantic (the oracle), not textual.

**Generated `Cargo.toml`** path-deps into `gears-rust` with relative paths. Those crates use
`edition.workspace = true`, resolved from their own workspace root because they physically live
there, so external path deps work unchanged. Set `CARGO_TARGET_DIR` to `gears-rust/target` — that
is what `host_workers(target_dir = …)` is for.

**Generated AppConfig** writes `runtime: { type: oop, execution: {...} }` for worker anchors (the
key must exist — `build_oop_spawn_options` iterates `config.gears.keys()`), and deliberately writes
**no** `client_wiring` when a provider is co-located (absent ⇒ `ClientWiring::Local` is already
correct). The `leader_election` key is deliberately **omitted** from `cluster.profiles.default` —
that omission is what engages the SDK CAS default, and the lock records it as
`resolved = { via = "sdk-cas-default" }` so it reads as intentional.

**Helm.** Umbrella + one subchart per process with `enabled` flags. No `lookup`, no
`randAlphaNum`, no `genCA` — renders with zero cluster access. `values.generated.yaml` (Generated)
carries images/ports/replicas/wiring; `values.yaml` (OperatorOwned) is 3-way merged.
`values.schema.json` is composed programmatically in `SchemaGen` (top-level keys are per-process
and therefore dynamic): `schemars::schema_for!(EscapeHatches)` + `schema_for!(ExternalDatabase)`
merged under each process key, `additionalProperties: false`, `enum` for `pullPolicy`/`service.type`.
**Secrets: none in values** — Bitnami `existingSecret` + `existingSecretPasswordKey` only,
projected as `secretKeyRef` env consumed by the postgres plugin's `${PG_PASSWORD}` expansion.
Full escape-hatch set per subchart (`nameOverride`, `global.imageRegistry`, `podAnnotations`,
`nodeSelector`, `tolerations`, `affinity`, `resources`, `extraEnv`, `extraVolumes`,
`serviceAccount.*`, `podSecurityContext`, …). Probes from `oop_serve`: `/healthz`, `/readyz`.
Not generated: mini-chat's `lease.yaml`/`rbac.yaml` — those serve its private `k8s_lease` elector,
which is not a cluster provider.

**How the k8s profile works without a K8s-DNS resolver — the honest answer:**
- `discovery = "static"` (the default the prototype ships): write
  `gears.<consumer>.config.consumer_wiring.<provider> = "http://{{ .Release.Name }}-<subchart>:<port>"`
  into the consumer's **ConfigMap** (never env — `remap_gear_env_key` can't express it). The
  proxy-wiring phase installs `StaticEndpointResolver` and the REST resolving client hits the
  Service DNS name. **GBX0603** is emitted so nobody believes a DNS resolver exists.
- `discovery = "directory"` (opt-in): the gateway subchart runs `gear-orchestrator` + `grpc-hub` on
  a fixed port; workers get `TOOLKIT_DIRECTORY_ENDPOINT` and `APP__OOP_HTTP__ADVERTISE_URI` from
  the downward API with `allow_loopback_advertise: false`. This works today; it is just more moving
  parts, so it isn't the default.

---

## 8. JSON-RPC surface

**Transport.** stdio, JSON-RPC 2.0, `Content-Length: <n>\r\n\r\n<utf8 json>`. Byte-compatible with
`vscode-jsonrpc`'s `StreamMessageReader`/`Writer`. All logging goes to **stderr** plus
`gearbox/log` notifications. Started as `gearbox rpc --stdio [--allow-writes] [--root <dir>]`.

**Lifecycle:** LSP-shaped `initialize` / `initialized` / `shutdown` / `exit`, so one connection
serves both the Studio and the `.gdl` language client. `initialize` result advertises
`{ textDocumentSync, diagnosticProvider, completionProvider, hoverProvider, documentSymbolProvider,
definitionProvider, gearbox: { catalogue, resolve, generate, explain } }`.

**Methods:** `gearbox/catalogue/{load,get}`, `gearbox/product/{load,resolve,explain}`,
`gearbox/lock/{read,write,diff}`, `gearbox/generate/{plan,preview,apply}`, `gearbox/validate`,
`gearbox/graph`, `gearbox/watch/{start,stop}`.
`gearbox/generate/plan` returns `FilePlan[] = { path, action: create|update|unchanged|conflict,
ownership, sha256, previewAvailable }`.
`gearbox/graph` returns a `GraphDto { nodes: {id, kind, label, group?, badges[]}[],
edges: {from, to, kind, label?, style: solid|dashed}[] }` for views `deps|contracts|processes|cluster`.

**LSP subset:** `textDocument/didOpen|didChange|didSave|didClose|completion|hover|documentSymbol|definition`
(jump from `use_gear("x")` / `from_ = "x"` to the declaring `gear.gdl`).

**Notifications:** `textDocument/publishDiagnostics`, `$/progress`, `gearbox/log`,
`gearbox/catalogueChanged`, `gearbox/lockChanged`.

**Application errors** in the `-32000` block, `data.diagnostics` always populated:
`NotInitialized`, `WorkspaceNotOpen`, `GdlEvalFailed`, `ResolveFailed`, `GenerateFailed`,
`WritesDisabled`, `PathOutsideWorkspace`, `Cancelled` (`$/cancelRequest` honoured — catalogue scan
and resolve are cancellable), `SourceUnavailable`.

**TS types.** `ts-rs` 11 with `#[derive(TS)]` on every public `gearbox-ir` type plus the RPC
envelopes, `#[ts(export, export_to = "../../ide/gearbox-studio/src/common/generated/")]`, driven by
`cargo test export_bindings`. Chosen over `specta` for having no runtime component and matching
serde's `BTreeMap`/`Option`/tagged-enum encoding. **Two anti-drift guards:**
`make ts && git diff --exit-code ide/.../generated` must be a no-op, and
`gearbox rpc-schema` (schemars) is diffed against `fixtures/rpc-schema.json` so a rename that
ts-rs tolerates still shows as a fixture diff.

---

## 9. Theia Studio

```
ide/
  package.json            # private, npm workspaces
  theia-version.txt       # ONE pinned exact @theia/* version
  gearbox-studio/         # native Theia extension: views + engine supervision
    src/common/{protocol.ts, generated/}      # ts-rs output, checked in
    src/browser/{gearbox-studio-frontend-module.ts, gearbox-service.ts,
                 catalogue/, product/, graph/, explain/, lock/, generate/,
                 diagnostics/gearbox-marker-contribution.ts,
                 commands.ts, menus.ts, keybindings.ts, preferences.ts}
    src/node/{gearbox-studio-backend-module.ts, gearbox-engine-process.ts,
              gearbox-service-impl.ts}
  gdl-language/           # VS Code extension for the .gdl language
    {src/extension.ts, syntaxes/gdl.tmLanguage.json, language-configuration.json}
  browser-app/            # @theia/cli: theia build / theia start
  electron-app/           # + @theia/electron, electron-builder
```

**Package manager: npm workspaces.** No yarn is installed, and pnpm's non-hoisted `node_modules`
breaks Theia's plugin host and `@theia/cli` asset copying. `save-exact=true`.

**Theia version:** resolve `npm view @theia/core version` once, write it to `theia-version.txt`, and
use it verbatim for every `@theia/*` dep **plus root `overrides`** — a transitive `^` pulling a
second `@theia/core` copy breaks inversify identity and is the most common Theia build failure.
`engines: { node: ">=20 <21" }`.

**Extension points.** `theiaExtensions: [{ frontend: "lib/browser/gearbox-studio-frontend-module",
backend: "lib/node/gearbox-studio-backend-module" }]`.
Frontend: `AbstractViewContribution` + `WidgetFactory` per widget, `CommandContribution` /
`MenuContribution` / `KeybindingContribution` (`gearbox.resolve` = Ctrl+Alt+R, `generate.plan`,
`generate.apply`, `validate`, `explain.selection`, `engine.restart`),
`TabBarToolbarContribution`, `FrontendApplicationContribution`, `PreferenceContribution`
(`gearbox.enginePath`, `catalogueRoots`, `allowWrites` default false, `defaultProfile`),
`WebSocketConnectionProvider.createProxy<GearboxService>` + a `GearboxClient` callback for
notifications, and `ProblemManager` from `@theia/markers`.
Backend: `ConnectionContainerModule.create` + `RpcConnectionHandler<GearboxClient>` (one service
per frontend connection, one engine per workspace root) and `BackendApplicationContribution.onStop`.

**Widgets.**

| Widget | Shows |
|---|---|
| Catalogue | tree by `category` → gear; badges for `runtime_caps`, chips for `colocated_deps`, provides/consumes counts. Click reveals the `gear.gdl` at its declaring range. Checkbox produces a *proposed* `use_gear(...)` diff, never an auto-edit. |
| Product | profile dropdown; selected gears + a "pulled in by co-location" sublist; bindings table (`consumer → contract → provider` with mode/transport/mechanism chips); cluster table showing `selected` vs `resolved`; diagnostics summary bar. |
| Graph | four views. **deps** (solid = co-location), **contracts** (dashed = cuttable, solid = forced local, red = undeclared-hub-edge), **processes** (boxes with gear chips, overlapping gears drawn in *every* box — this is what makes closure-not-partition visible), **cluster** (requirement → capability → provider, unsatisfied in red). Layout: `elkjs` `layered` with a fixed seed → deterministic, so screenshots and "why did this move" are stable. Rendered as hand-written React SVG. |
| Explain | `gearbox/product/explain` for the current selection: `narrative: string[]` as an ordered list, each step linking to its `origin`, plus the subgraph inline. Every `DowngradedBy` edge renders "you asked X → you got Y → because GBXnnnn" with a link to the evidence `file:line`. |
| Lock | read-only Monaco view of canonical `product.lock`, diff toggle vs disk, `lock_hash` badge that goes stale-yellow when resolve ≠ disk. |
| Generate | `FilePlan[]` as a directory tree with create/update/unchanged/conflict icons, per-file Monaco diff preview, ownership badge, Apply disabled unless `allowWrites` and no Errors and no conflicts. |

**Engine supervision** (`src/node/gearbox-engine-process.ts`): one engine per workspace root;
`child_process.spawn(enginePath, ['rpc','--stdio','--root',root,…])`;
`createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin))`
from `vscode-jsonrpc/node`; `child.stderr` piped line-by-line into a "Gearbox Engine"
`OutputChannel`. Exponential-backoff restart (250 ms → 4 s, 5 attempts, reset after 60 s healthy),
then a `MessageService.error` with a Restart action. `onStop` sends `shutdown` + `exit`, waits 2 s,
then `SIGKILL`. Version guard comparing `serverInfo.version` to the extension's, since the ts-rs
types are compiled against a specific engine.

**Diagnostics → markers, two deliberate paths.** File-anchored GDL/validate diagnostics
(GBX01xx/02xx) arrive over `textDocument/publishDiagnostics` from the `gdl-language` LSP client and
Monaco renders them natively — zero code in `gearbox-studio`. Resolve/generate diagnostics
(GBX03xx–07xx) come back in the resolve result and are mapped by `GearboxMarkerContribution` to
`ProblemManager.setMarkers(uri, 'gearbox', markers)` — a single owner string, so a re-resolve
replaces the whole set atomically and stale markers can't accumulate. Diagnostics with no location
anchor to `product.gdl` at 0:0 with the evidence in `relatedInformation`. `data.help` becomes a
quick-fix-shaped code action where the remedy is mechanical (add a `#[toolkit::consumes]` line, add
a gear to `colocated_deps`, switch a cluster provider).

**`.gdl` language** ships as the bundled VS Code extension (the officially supported path),
declared in `browser-app/package.json` via `theiaPlugins`. Contributes `languages` (`.gdl`,
filenames `gear.gdl`/`product.gdl`) + `grammars`. The TextMate grammar derives from Starlark/Python
with the GDL vocabulary as `support.function.gdl` and namespaces as `support.constant.gdl`; the
**forbidden** keywords (`if`, `for`, `def`, `lambda`, `while`) are scoped `invalid.illegal.gdl` so
they render red before the engine even reports GBX0103. `extension.ts` starts a `LanguageClient`
against `gearbox rpc --stdio`. Completion is context-sensitive from the engine: inside
`runtime_caps = [` the 7 caps; inside `provider(` only `standalone`/`postgres`; inside `from_ = "`
catalogue gear ids; inside `colocated_deps = [` gear ids annotated with the closure size each pulls in.

---

## 10. The slice

**Real gears (pre-existing, untouched except for an added `gear.gdl`):**

| Gear | Path | Role in the slice |
|---|---|---|
| `api-gateway` | `gears/system/api-gateway` | the only `rest_host`; its `deps` silently pull in 3 more gears — proves closure |
| `grpc-hub` | `gears/system/grpc-hub` | the only `grpc_hub`; publishes the endpoint `run_oop_spawn_phase` waits on |
| `authn-resolver` | `gears/system/authn-resolver/authn-resolver` | closure depth 2 |
| `types-registry` | `gears/system/types-registry/types-registry` | closure depth 3 |
| `gear-orchestrator` | `gears/system/gear-orchestrator` | `DirectoryService` server |
| `api-contracts` | `examples/toolkit/api-contracts/api-contracts` | provides `PaymentApi@v1`+`@v2` over `[local, rest]`; also the `lib_ident != gear_snake` case |
| `api-contracts-consumer` | `.../api-contracts-consumer` | two real `#[toolkit::consumes]` edges |
| `cluster` | `gears/system/cluster/cluster` | the provider registry |

**New custom gear: `payments-audit`** — `gears-rust/gears/payments-audit/{payments-audit-sdk,payments-audit}/`

```rust
#[toolkit::gear(name = "payments-audit", deps = [cluster],
                capabilities = [rest, stateful],
                lifecycle(entry = "serve", stop_timeout = "15s"))]
#[toolkit::provides(contract = payments_audit_sdk::PaymentsAuditApi,
                    local = Self::build_local, transports = [local, rest])]
#[toolkit::consumes(contract = api_contracts_sdk::PaymentApi, from = "api-contracts")]
#[derive(Default)] pub struct PaymentsAudit { /* OnceLock<Arc<AuditService>> */ }
```

`kebab(PaymentsAudit) == "payments-audit" == name`, so the `consumer_wiring` override key resolves.
The leader (via `LeaderElectionV1`) reconciles the trail every 5 s through `PaymentApi`, writing back
via `ClusterCacheV1` CAS; followers serve `trail` from cache.

Why this shape: it is the only gear that simultaneously exercises **a cuttable contract edge**
(`api-contracts ∉ closure`), **an uncuttable co-location edge** (`cluster`), **a cluster capability
requirement with a real provider decision**, and **a provided contract that becomes a
`cuttable_if_declared` candidate** for `api-contracts-consumer`. Every resolver branch in §5 is
reachable from it.

**Nine additive `gear.gdl` files** in `gears-rust` (one per slice gear), plus two `Cargo.toml`
workspace-member entries. Nothing else in that repo changes.

---

## 11. Milestones

| # | Deliverable | Verification | Parallel |
|---|---|---|---|
| **M0** | **PRD** (§14) — short, `docs/PRD.md` | reviewed against `gears-rust/docs/checklists/PRD.md`; every FR/NFR has an ID and a p-tier; every acceptance criterion maps to a §12 step | — |
| **M1** | Workspace + IR + lock | `cargo test -p gearbox-ir -p gearbox-lock` incl. a proptest asserting byte-stability over 1000 shuffled input orderings; `make ts && git diff --exit-code` | — |
| **M2** | GDL evaluator | `gearbox catalogue --root ../gears-rust --format json \| jq '.gears \| length'` == 9; a fixture per GBX01xx code; dialect + blacklist + `load()` sandbox tests | M3 |
| **M3** | `gearbox validate` | `gearbox validate --root ../gears-rust` → 0 errors; a negative fixture per GBX02xx (esp. 0206 kebab-struct-vs-name, 0204 cluster registry drift) | M2, M8a |
| **M4** | Resolver + explain + lock | all three profiles diff clean against `fixtures/*/product.lock`; every GBX03xx–06xx code reachable; determinism loop | M8a |
| **M5** | Crate + config generators; **embedded runs** | acceptance §12 step 2 in full | — |
| **M6** | Host-workers | new gear lands and passes its own test *by hand first*; then generated worker crate; host spawns worker; remote REST binding resolves via directory | M7 |
| **M7** | Docker + Helm + `values.schema.json` | acceptance §12 step 4 in full | M6 |
| **M8a** | JSON-RPC + TS types | `node ide/scripts/rpc-smoke.mjs` drives initialize → catalogue → resolve → generate/plan over real framing | from M1 |
| **M8b** | Theia Studio | acceptance §12 step 9 | after M4 + M8a |
| **M9** | **DESIGN + ADRs** (§14) — written *after* the prototype runs | reviewed against `docs/checklists/{DESIGN,ADR}.md`; every claim cites either a `gearbox-builder` symbol or a `gears-rust` `file:line`; every §13 gap has a home | — |

Critical path M0 → M1 → M2 → M4 → M5 → M6 → M9. M8a needs only types, so its widgets can be
stubbed against `fixtures/*/product.lock` until M4 lands.

**Sequencing constraint worth stating explicitly:** M6 requires writing real Rust in `gears-rust`
that must compile and pass its own integration test **before** the generator is trusted. Do it by
hand first with a throwaway app crate modelled on
`examples/toolkit/api-contracts/api-contracts-consumer/tests/provider_consumer.rs`, then delete the
throwaway and let the generator reproduce it. Otherwise a generator bug and a gear bug are
indistinguishable.

---

## 12. Verification

Prerequisites: `rustup toolchain install 1.97.0`; `brew install kubeconform kind yq`
(`helm`, `docker`, `jq` are already present).

**Step 0 — baseline.** `make oop-example` is stale; re-establish Profile 2 by hand
(`cargo build -p calculator --features oop_module`, then run the example server with
`config/oop-example-master+follower.yaml` and curl the calculator route) before trusting any
generated output.

**Step 1 — validate.** `gearbox validate --root ../gears-rust` → 0 errors.

**Step 2 — embedded.** Resolve + generate + `cargo build --bin gbx-api-gateway`, then the oracles:
```bash
./target/debug/gbx-api-gateway --list-registered-gears | cut -f1 \
  | diff - <(gearbox lock gears --process api-gateway --order topo)
./target/debug/gbx-api-gateway --config config/api-gateway.yaml --dump-gears-config-yaml \
  | diff - fixtures/dev/effective-gears.yaml
```
Run it; assert both REST surfaces answer and `WireOutcome::Local` appears for all three bindings
with no readiness gate.

**Step 3 — host-workers.** Resolve + generate + build both bins; start Postgres in Docker; run the
host. Assert: `pgrep -f gbx-payments-audit` (the host spawned it via `LocalProcessBackend`),
`curl -sf localhost:8091/readyz` (self-registered via `oop_serve`),
`wire_outcome=Remote` for `PaymentApi` in the worker log, and
`gearbox lock processes --format json | jq -e '… .gears == ["cluster","payments-audit"]'`.

**Step 4 — kubernetes.** `helm lint` + `helm template` + `kubeconform`, then the hard assertions:
```bash
! grep -qrE '\blookup\b|randAlphaNum|genCA' payments-demo/templates payments-demo/charts
! grep -qiE 'password:|apiKey:' payments-demo/values.yaml payments-demo/values.generated.yaml
yq '.. | select(has("consumer_wiring")).consumer_wiring' /tmp/rendered.yaml | grep -q 'api-contracts:'
! grep -q 'APP__GEARS__.*CONSUMER_WIRING' /tmp/rendered.yaml     # grounded fact: env can't express it
! helm template payments-demo payments-demo --set audit.replicaCount=two   # schema rejects garbage
gearbox resolve … --format json | jq -e '.diagnostics[] | select(.code=="GBX0603")'
```
Optional: `kind` + `kind load docker-image` + `helm install --wait`.

**Step 5 — negative cluster case.** Add `cluster_cap.prefix_watch` to the cache requirement; expect
a non-zero exit, no lock, and both `GBX0502` (no provider satisfies `{linearizable, prefix_watch}`
— with the per-provider ✔/✘ table and the `CacheFeatures::new(false)` citation) and `GBX0503`
(`standalone` is process-local but `audit` has replicas=2).

**Step 6 — determinism.** Resolve three times → one distinct sha256. Apply generate twice →
`git status --porcelain` empty the second time.

**Step 7 — gear src unchanged (the whole point).**
```bash
cd ../gears-rust
test -z "$(git status --porcelain -- ':!**/gear.gdl' ':!gears/payments-audit' \
                                    ':!Cargo.toml' ':!Cargo.lock')"
for p in gears/system/api-gateway gears/system/grpc-hub gears/system/gear-orchestrator \
         gears/system/authn-resolver gears/system/types-registry gears/system/cluster \
         examples/toolkit/api-contracts; do
  git diff --exit-code HEAD -- "$p/**/*.rs" "$p/**/Cargo.toml" || { echo "MUTATED: $p"; exit 1; }
done
git diff --exit-code HEAD -- gears/payments-audit/payments-audit/src   # same src, 3 topologies
```

**Step 8 — TS anti-drift.** `make ts && git diff --exit-code ide/.../generated`;
`gearbox rpc-schema | diff - fixtures/rpc-schema.json`.

**Step 9 — Studio.** `cd ide && npm ci && npm run build && npm run start:browser`. Assert:
Catalogue lists 9 gears; the profile dropdown has dev/local/prod; switching to prod surfaces
GBX0603 + GBX0507 in Problems; the Graph "processes" view shows 2 boxes with `cluster` inside
`audit`; clicking the `payments-audit → api-contracts` edge opens Explain with the DowngradedBy
narrative; Generate shows 0 conflicts, and after hand-editing `values.yaml` a re-apply reports it
`unchanged` (the 3-way merge preserved it).

---

## 13. Honest gaps — what this will NOT prove

1. **Multi-host anything.** `LocalProcessBackend` is the only spawn backend (GBX0604).
2. **A real Kubernetes control loop.** Nothing in the runtime knows about K8s. Helm output is a
   static manifest set; the only k8s-aware behaviour is Service DNS pinned into a ConfigMap and
   optionally `POD_IP` from the downward API.
3. **gRPC across a process boundary via declared contracts.** `#[toolkit::consumes]` emits a REST
   client only; GBX0402 downgrades rather than emitting config that silently does nothing.
4. **Roles, shards, per-instance addressing.** GBX0601/0602 refuse to pretend; `declared_roles` is
   stored for forward-compat and contributes nothing to the lock.
5. **Cluster coordination beyond `standalone` + `postgres`.** Leader election has *zero* registered
   providers and always resolves to the SDK CAS default.
6. **`prefix_watch` in any distributed setting.** GBX0502 is the correct answer, not a workaround.
7. **The cluster gear in a running product** — it is wired into no runnable app today;
   `payments-audit` will be the first. Expect real friction (migration ordering vs the `db`
   lifecycle phase, `ClusterProfile` scope naming, CAS backends rejecting weak consistency).
   **Budget a milestone-sized slip on M6 for this specifically.**
8. **Cutting the interesting real-world edges.** 33 of 39 gears use `deps`; `types_registry` is
   pulled by ~22. The resolver never cuts an undeclared edge — it *reports* it with the literal
   annotation to add. That report is the deliverable; actually cutting those edges needs the
   annotations to exist first.
9. **Byte-identical Rust vs hand-written references.** Generated `registered_gears.rs` has no
   `#[cfg(feature)]` gates by design; validation is the `--list-registered-gears` oracle, not `diff`.
10. **Speed.** Path-deps into a large repo; a cold generated build is minutes and `docker build`
    needs a context spanning both repos.
11. **Starlark API churn.** `starlark-rust` is pre-1.0; pin exactly and let nothing outside
    `gearbox-gdl` name a `starlark::` type.
12. **The `runtime.type: oop` double-instantiation hole.** The registry has no runtime-kind
    awareness, so a gear both linked into the host *and* marked `oop` is instantiated locally **and**
    spawned as a child — which is what `calculator` does today. The generator sidesteps this by
    never linking a worker's anchor crate into the host, which in turn means the host cannot declare
    `deps = [<worker anchor>]` or `build_topo_sorted` hard-fails. This is a genuine structural limit
    of Profile 2: **a gear can move out of process only if nothing left in the host declares it as a
    `deps` target.** The resolver enforces it (that *is* `CutBlocker::ColocationClosure`), so
    `calculator-gateway`-shaped designs cannot be reproduced by the generator — and should not be,
    because they are the double-instantiation bug.

Every "not supported" diagnostic (GBX0402, 0409, 0505, 0601–0606) carries an `evidence` field with a
real `file:line` in `gears-rust`, so a reader can verify the claim in ten seconds instead of
trusting the tool.

---

## 14. Spec artefacts — PRD now, DESIGN after

Both live in `gearbox-builder/docs/` and follow `gears-rust/docs/spec-templates/gears-sdlc/`
verbatim, so a Gears reviewer needs no context switch. `system` slug = **`gearbox`**, giving IDs
`cpt-gearbox-fr-…`, `-nfr-…`, `-actor-…`, `-usecase-…`, `-design-…`, `-adr-…`. Priority tiers are
`p1`/`p2`/`p3` (the templates forbid SHOULD/MAY — use a tier instead), requirement text uses
**MUST**, and the TOC placeholder is filled by `cfs toc`. No `UPSTREAM_REQS.md` exists for this
system, so the `Covers:` field is omitted throughout.

### M0 — `docs/PRD.md` (before any code)

Short on purpose: it is an alignment artefact, not a substitute for the vision doc. Sections per
the template, with the content already derived above:

| Template section | Content source |
|---|---|
| 1 Overview / Problem / Goals | vision §1–3, §119–122; the goal is "configure intent, derive implementation, explain every decision" |
| 1.4 Glossary | Catalogue / Intent / ResolvedProduct / DeploymentProfile / ClusterScope / co-location vs contract consumption — the terms the vision insists must not be conflated (§14, §24–26, §30) |
| 2 Actors | `cpt-gearbox-actor-gear-author`, `-integrator`, `-platform-engineer`, `-external-agent` (via RPC/MCP), `-theia-studio` (system actor), `-cargo` / `-helm` (system actors) |
| 3 Operational Concept | offline, no cluster access at render time, no network at resolve time, deterministic |
| 4 Scope | in: GDL/resolver/lock/generators/RPC/Studio for the §10 slice. out: MCP, TUI, Rego, registry sources, SAT/SMT, scoring, migration tooling, CI, mass gear migration |
| 5 FRs | one per resolver responsibility and generator output — e.g. `-fr-gdl-declarative` (§3.2), `-fr-derive-binding-from-placement`, `-fr-never-cut-undeclared-edge`, `-fr-report-cuttable-if-declared`, `-fr-cluster-capability-match`, `-fr-generate-process-crate`, `-fr-values-schema`, `-fr-no-secrets-in-values`, `-fr-diagnose-unsupported` |
| 6 NFRs | `-nfr-determinism` (same input ⇒ byte-identical lock), `-nfr-explainability` (every automatic choice answers "why" without an LLM), `-nfr-provenance-during-resolution`, `-nfr-render-without-cluster`, `-nfr-operator-values-preserved`, `-nfr-engine-has-no-frontend-deps`, `-nfr-evidence-cited` (every "unsupported" diagnostic carries a real `file:line`) |
| 7 Public Library Interfaces | the JSON-RPC surface (§8) + the `gearbox` CLI verb set — this is the external contract |
| 8 Use Cases | `-usecase-switch-profile` (the canonical one), `-usecase-explain-provider-choice`, `-usecase-diagnose-invalid-topology` |
| 9 Acceptance Criteria | **each criterion maps 1:1 to a §12 verification step**, so the PRD is falsifiable rather than aspirational |
| 10–13 Deps / Assumptions / Risks / Open Questions | §13 gaps become Risks; the OLD doc's "Key Assumptions to Validate" list becomes Assumptions; vision §118's 20 open questions are filtered to the ones this slice actually answers |

Deliberately **not** in the PRD: crate layout, IR types, resolver algorithm, GDL syntax — those are
DESIGN, and writing them now would be guessing.

### M9 — `docs/DESIGN.md` + `docs/ADR/` (after the prototype runs)

Written last, so every statement is a report rather than a forecast. Sections map onto this plan:
§1.1–1.3 ← §2 (crate DAG, layering, the engine/frontend boundary test); §2 ← §2.2 design rules;
§3.1 Domain Model ← §4 IR; §3.2 Component Model ← §2.1 + §5 resolver stages; §3.3 API Contracts ←
§8 RPC + the GDL host API; §3.5 External Dependencies ← the pinned crate list *with the versions
that actually worked*; §3.6 Interactions ← the resolve and generate sequences; §3.8 Deployment
Topology ← §7 generators and the three profiles. `product.lock`'s schema is the "data model", so
§6 of this plan graduates into DESIGN §3.1 rather than being restated.

ADRs only where the rationale genuinely needs recording (the template warns against "everything is
a decision"). The set worth writing, as `docs/ADR/NNNN-cpt-gearbox-adr-<slug>.md`:

| # | Slug | The dilemma |
|---|---|---|
| 0001 | `gdl-starlark-over-toml` | vision says Starlark; the repo-grounded predecessor says TOML + syn and calls Starlark "a language subsystem with no consumer". Record why the prototype chose Starlark *and* what would justify reverting. |
| 0002 | `gear-gdl-single-source-of-truth` | GDL authoritative + `validate` cross-check, vs catalogue-parsed-from-Rust with GDL as overlay. Includes the three-confidence-level model that was rejected. |
| 0003 | `colocation-is-a-closure-not-a-partition` | the `MissingDeps` finding, why `deps` edges are uncuttable, and why processes overlap. The most consequential correction to the vision. |
| 0004 | `product-lock-canonical-serialization` | TOML + `blake3` over the body, `lock_hash` elided; why arrays-of-tables and BTreeMap iteration are load-bearing, not cosmetic. |
| 0005 | `rpc-jsonrpc-stdio-lsp-framing` | stdio LSP framing vs local HTTP vs WASM; why one server backs both the Studio and the `.gdl` language client. |
| 0006 | `template-text-serialize-data` | minijinja for text, serde for data, `<< >>` for Helm sources; the YAML-indentation failure mode being avoided. |
| 0007 | `k8s-static-endpoint-resolution` | no K8s-DNS `EndpointResolver` exists; ConfigMap-pinned `consumer_wiring` + GBX0603 vs waiting for a runtime feature vs faking it. |
| 0008 | `unsupported-is-a-diagnostic-not-an-omission` | roles/shards/providers/profiles are parsed and then explicitly refused with cited evidence, rather than being absent from the grammar. |

Each ADR's Traceability section links back to the `cpt-gearbox-fr-*`/`-nfr-*` IDs from M0 and the
`-design-*` elements from M9, and each Confirmation section names the test that enforces it (e.g.
0003 → the `--list-registered-gears` oracle; 0004 → the byte-stability proptest; 0008 → the
per-diagnostic fixtures).

---

## Critical files

- [docs/gearbox-builder-vision.md](docs/gearbox-builder-vision.md) — §12 (declarative rule), §22
  (lock contents), §47–48 (process crates), §51–58 (templating + Helm) are the normative constraints
- `gears-rust/libs/toolkit/src/registry.rs` — `Registrator`, `build_topo_sorted`, `MissingDeps`;
  why `deps` is uncuttable and the source of the `--list-registered-gears` oracle
- `gears-rust/libs/toolkit/src/runtime/host_runtime.rs` — lifecycle phase order, `consumer_wiring`
  static override, `WireOutcome` consumption, `run_oop_spawn_phase`
- `gears-rust/libs/toolkit/src/bootstrap/config/mod.rs` — `AppConfig`, `GearRuntime`,
  `ExecutionConfig`, `OopHttpConfig`, and `remap_gear_env_key`
- `gears-rust/libs/toolkit-contract-macros/src/consumes.rs` — REST-only resolving client,
  `owner_gear` from struct ident, no topo dep
- `gears-rust/gears/system/cluster/cluster/src/gear.rs` — `provider_registry()`, the hardcoded set
  the resolver matches against
- `gears-rust/gears/mini-chat/deploy/{helm/mini-chat,docker/mini-chat.Dockerfile}` — the only chart
  and container build in the repo; golden references
- `cargo-gears/design/ideas/gears-product-configurator-OLD.md` — the repo-grounded predecessor whose
  conclusions (co-location collapse, "unannotated is never split", template-text/serialize-data,
  Helm must-haves) are folded into this plan
- `gears-rust/docs/spec-templates/gears-sdlc/{PRD,DESIGN,ADR}/template.md` and
  `gears-rust/docs/checklists/{PRD,DESIGN,ADR}.md` — the exact form and review bar for §14
