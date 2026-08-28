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
- **The catalogue is a merge, not a mirror** (ADR 0002): every fact a Rust attribute already carries
  is *projected* out of it via `syn`; `gear.gdl` *declares* only the facts that have no Rust home,
  and a description restating a projected fact is rejected.
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
| No gear manifest exists. Gear metadata lives **only** in `#[toolkit::gear(name, deps, capabilities, ctor, client, lifecycle)]`, and no `gear.toml` exists anywhere (`find -name gear.toml` = 0) | `libs/toolkit-macros/src/lib.rs` | `gear.gdl` carries **only** genuinely new information — enforced, not merely intended, by `cpt-gearbox-fr-gdl-no-restatement` |
| The gear attribute's location is not uniform: 34 of 44 at `src/gear.rs`, 8 at `src/module.rs`, 2 nested; and `gears/mini-chat/mini-chat` declares **three** gears in one crate | `grep -rln '#\[toolkit::gear('` over `gears/` + `examples/` | projection needs a locator: scan `src/` by default, optional `cargo(attr = …)` to narrow, exactly-one-match required (`cpt-gearbox-fr-attribute-location`) |
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
    gearbox-verify/       # syn scan of gear crates → the projected half of the
                          # catalogue (ADR 0002; rename candidate: gearbox-scan)
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

**ADR 0002 changes `gearbox-verify`'s position.** Under projection the `syn` scan is not a
validate-time check but a *catalogue-load input*, so descriptor assembly consumes both it and
`gearbox-gdl`; nothing can build a `GearDescriptor` from GDL alone. The name no longer fits either —
it verifies nothing, it reads — so `gearbox-scan` is the rename candidate. Decide when the crate is
actually written (M2), not now.

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

### 2.3 Catalogue loading is staged, because the data costs differ by orders of magnitude

An engine property, not an RPC detail: the same stages back the single-shot CLI path and the
incremental one the Studio needs. ADR `cpt-gearbox-adr-staged-catalogue-loading` is the authority.

| stage | work | what it yields | cost on the slice |
|---|---|---|---|
| **S0** discover | one walk per source root for `gear.gdl` | paths only | one walk |
| **S1** declare | evaluate each description (Starlark, tiny); locate documents (`stat` only) | `display_name`, `description`, `category`, `visibility`, `package`/`sdk` locators, `requires`, `serves`, `cluster_plugins`, `docs` | ms per file |
| **S2** project gear | `syn` over the gear crate's `src/` | `id`, `runtime_caps`, `colocated_deps`, `lifecycle`, `client_trait`, `fills`, provider transports | **165 files** |
| **S3** project sdk | `syn` over the SDK crates | contracts, extension points, GTS types, vendor defaults | 90 files, **crates shared** |
| **S4** join | contract merge, plugin resolution | GBX0206, GBX0511–GBX0517 | cheap, needs S2+S3 of the participants |

Measured: 255 `.rs` files for the 14-gear slice at ~0.7 s; **2658** `.rs` files under `gears/`, so a
full registry is roughly ten times that.

**The consequence that shapes the UI: `GearId` is projected, so it does not exist until S2.** At S1
there is a name to show and no identifier to key by, so a tree must key rows by `gdl_path` and join
the `id` later. An implementation that keys by `id` has no choice but to block on every crate — which
is why this is a requirement and not an optimisation.

**"Not yet computed" is a separate list, never a third state on a field.** `CatalogueScan` carries
`pending: Vec<PendingGear>` beside `catalogue.gears`; a gear in `gears` is complete and readable
without qualification. `Option::None` and an empty `Vec` keep exactly one meaning — *absent* — which
is what stops a consumer rendering "no GTS types" for a gear nobody has looked at yet.

**Parsing each crate once per load is a precondition of all this**, and is done: a staged loader that
re-parses shared crates cannot be cheap however it is scheduled. Before the cache,
`tenant-resolver-sdk` was read four times on the slice (host plus three plugins) and
`authn-resolver-sdk` three; now the same load parses **19 crates for 25 requests**, which
`gearbox catalogue --format text` reports.

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
    # NOT DECLARED HERE, projected from Rust (ADR 0002). Writing any of these is
    # GBX0210 `cpt-gearbox-fr-gdl-no-restatement`, which names the owning attribute:
    #   id            <- #[toolkit::gear(name = "payments-audit")]
    #   runtime_caps  <- capabilities = [rest, stateful]
    #   colocated_deps<- deps = [cluster]   (link-time; see the note below)
    #   lifecycle     <- lifecycle(entry = "serve", stop_timeout = "15s")
    #   client_trait  <- client = ...
    #   contract id / version / kind on every provide+consume below

    name = "Payments Audit",
    description = "Cluster-cached audit trail; the elected leader reconciles it periodically.",
    category = "example",
    visibility = "public",

    # lib is MANDATORY, never derived — cf-api-contracts has no [lib] section.
    # attr is OPTIONAL: omitted means scan this crate's src/ tree and require
    # exactly one #[toolkit::gear]. payments-audit puts it at the modal location.
    package = cargo(crate = "cf-gears-payments-audit", lib = "payments_audit",
                    path = ".", link = ["payments_audit"],
                    attr = "src/gear.rs"),

    provides = [
        provide(contract = "PaymentsAuditApi",
                rust = "payments_audit_sdk::PaymentsAuditApi", sdk = AUDIT_SDK,
                local = "Self::build_local",
                # No `transports`: the set comes from this gear's own
                # #[toolkit::provides(transports = [...])], checked against
                # whether `PaymentsAuditApiRest` / `...Grpc` exist beside the
                # base trait in the sdk. Declaring it here is GBX0210.
                rest = rest(base_path = "/api/v1/payments-audit")),
    ],

    # `from_` and `critical` are product-level; the contract identity and the fact
    # that the edge exists at all come from #[toolkit::consumes]. Remote-capable +
    # annotated in Rust => the resolver MAY cut this edge.
    consumes = [
        consume(contract = "PaymentApi",
                rust = "api_contracts_sdk::PaymentApi", sdk = PAYMENT_SDK,
                from_ = "api-contracts", critical = False),
    ],

    requires = [
        # `profile` is mandatory and is a join key: it must name a profile this
        # crate implements as `impl ClusterProfile { const NAME }`. No default --
        # a defaulted `"default"` would resolve to a scope nothing registered.
        cluster.cache(profile = "payments-audit", capabilities = [cluster_cap.linearizable]),
        cluster.leader_election(profile = "payments-audit"),
    ],

    serves = [endpoint(name = "rest", via = "rest_host")],
)
```

Note what is *gone* versus the pre-ADR-0002 draft: `id`, `runtime_caps`, `colocated_deps`,
`lifecycle`, and the `version`/`kind` arguments on `provide`/`consume`. `colocated_deps` in
particular was never GDL's to own — the macro emits `pub use ::cluster as _gear_dep_cluster`, so the
authority for that edge is the linker, and a missing dep is `RegistryError::MissingDeps`. It stays
uncuttable for exactly that reason.

The `cluster` gear's `cluster_providers` are likewise projected — so a new provider registered in
Rust appears in the catalogue with no edit anywhere, and **GBX0204 disappears entirely**: there is no
second list to rot. It takes three hops, because no single place has the whole answer:

| hop | source | yields |
|---|---|---|
| 1 | `ClusterGear::provider_registry()` — the `with_*_provider` chain | which provider types, for which primitive |
| 2 | the plugin crate's `impl Cluster*Provider::provider()` → its `PROVIDER_NAME` const | the operator-facing name |
| 3 | the plugin crate's unique `impl ClusterCacheBackend`/`DistributedLockBackend`/`LeaderElectionBackend` | `consistency()` and `features()` |

Hop 3 is the one that surprises: **the provider traits carry no capability at all**, only a name and
a `build_*` factory. Capabilities live on the backend the factory returns behind an `Arc<dyn _>`, and
no source-level parse can follow that value flow. It does not have to — within one plugin crate there
is exactly one impl of each backend trait, so the impl is locatable by trait, and a crate that grows
a second one is reported (GBX0510) and narrowed rather than guessed.

Hop 2 needs one fact Rust cannot supply: the registry writes
`standalone_cluster_plugin::StandaloneCacheProvider`, and nothing in that expression says which
directory the crate is in. So the cluster description declares a locator — the same role `sdk` plays
for a contract:

```python
cluster_plugins = [
    cluster_plugin(
        package = cargo(crate_name = "cf-gears-standalone-cluster-plugin",
                        lib = "standalone_cluster_plugin",
                        path = "../plugins/standalone-cluster-plugin"),
        process_local = True,        # declared: no Rust construct states it
        needs_credentials = False,
    ),
]
```

`process_local` and `needs_credentials` stay declared deliberately. The nearest signal in Rust is
that one plugin's options carry a `connection_string` and the other's do not, and reading deployment
semantics out of that would be an inference rather than a fact. `process_local` is also what GBX0503
rests on, which is a reason to write it down rather than derive it almost-correctly.

The SDK's fall-back backends are projected as a **rule**, not a value: `defaults/{lock,leader}.rs`
compute `Features::new(self.cache.consistency() == Linearizable)`, so leader election and lock inherit
whatever the profile's cache declares. Both real caches are linearizable today, so the rule always
yields `true` — recording the rule rather than that answer is what keeps it correct when a third
cache lands.

### 3.4.1 Why `attr` exists — `mini-chat`

One crate can declare several gears. `gears/mini-chat/mini-chat` declares three, so it needs three
descriptions, each pinning its own attribute:

```python
# gears/mini-chat/mini-chat/gear.gdl                     -> "mini-chat"
package = cargo(crate = "cf-gears-mini-chat", lib = "mini_chat", path = ".",
                attr = "src/gear.rs",
                link = ["mini_chat",
                        "mini_chat::infra::plugins::static_audit",
                        "mini_chat::infra::plugins::static_model_policy"])

# .../src/infra/plugins/static_audit/gear.gdl  -> "static-mini-chat-audit-plugin"
package = cargo(crate = "cf-gears-mini-chat", lib = "mini_chat", path = "../../../..",
                attr = "src/infra/plugins/static_audit/gear.rs")
```

Omitting `attr` here is `GBX0211`: three candidates, and the diagnostic lists all three paths plus
the literal `attr = "…"` line to add. This is also why a description cannot be required to sit at
the crate root — `gdl_path` is already a `RelPath`, so the IR needs nothing new.

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
    # `name` must match a profile some gear implements as `impl ClusterProfile`;
    # this is the operator side of the same join key the gear declares.
    # `provider("...")` here *references* a catalogue provider by name — it is
    # not the retired gear-side `provider(...)` record, which described one.
    cluster_profiles = [
        cluster_profile(name = "payments-audit", cache = provider("standalone"), profiles = ["dev"]),
        cluster_profile(name = "payments-audit", profiles = ["local", "prod"],
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

**What shipped in M2, and where it differs from the example above.**
`products/payments-demo/product.gdl` exists and evaluates
(`gearbox product --file products/payments-demo/product.gdl`). It lists the four slice gears rather
than five: `payments-audit` is the new custom gear and arrives with M6, so a `use_gear` naming it
today would reference a gear no source provides. Its cluster scope is `event-broker`, the one profile
name a real `impl ClusterProfile` supplies.

Three surface decisions settled by implementing it:

- **Single-argument constructors are positional** — `path("…")`, `provider("…")`, `use_gear("…")`,
  `process("…")`. Everything else stays keyword-only, so `path(at = "…")` would only name the obvious
  while `bind(consumer = …, contract = …)` genuinely needs the labels.
- **`provider(...)` is the only function taking `**kwargs`.** A cluster plugin's option schema is
  genuinely open — the SDK hands a plugin a raw JSON map and keeps the schema out of the framework —
  so there is no arity to check. Everywhere else the parameters are spelled out, which is what makes
  an unknown argument GBX0106 instead of a silently ignored key. Options are sorted by key on the way
  into the IR, because `SmallMap` preserves the order the author happened to type and the lock must
  not depend on it.
- **`gear()` and `product()` live in different global sets**, so a file that calls the wrong one fails
  at the call rather than producing half of each.

An option that is not a string, integer, bool, list or map is refused rather than encoded as JSON
`null` — the lock is TOML, and TOML has no null.

**GBX0110 is now reachable, and GBX0107 appears not to be.** Duplicate profile-scoped declarations
are real and tested: two `bind` entries for one edge in one profile, an unscoped entry colliding with
a scoped one, one cluster scope bound twice, and a duplicate profile id. Disjoint scopes correctly do
*not* collide, which is the whole point of declaring profiles as data.

`GBX0107` (`GdlDowngraded`, "accepted for forward compatibility but excluded from resolution") has no
honest firing site at evaluation time: every case it was meant to cover has a more specific code —
`GBX0601`/`GBX0602` for roles and shards, `GBX0605` for registry sources. It also carries
`requires_evidence = true`, so firing it would mean citing a runtime limitation it does not name.
Either it belongs to the resolver (M4) or it should be retired the way `GBX0201`-`GBX0205` were; not
invented a use for in the meantime.

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
  consumes, requires, serves, client_trait, cluster_providers, declared_roles, config_schema }` —
  the **merge** of two disjoint origins (ADR 0002), which the IR does not distinguish because by the
  time a descriptor exists the distinction is spent:

  | Origin | Fields |
  |---|---|
  | **projected** from Rust | `id`, `runtime_caps`, `colocated_deps`, `lifecycle`, `client_trait`, `cluster_providers` (primitives, names, capabilities), cluster profile names, the contract identity/version/kind inside `provides`/`consumes`, the **transports** each provider wires up (from its own `#[toolkit::provides]`, checked against the projection traits the sdk declares), the **GTS types** its sdk declares, and `extension_points` / `fills` / `vendor_selector`. From *Rust*, not only from an *attribute*: provider names come from a `PROVIDER_NAME` const, capabilities from a backend trait impl, transports from which projection traits exist, and vendor defaults from either `impl Default` or `#[serde(default = "…")]` |
  | **declared** in `gear.gdl` | `display_name`, `visibility`, `package`, `sdk` (crate locator for the plugin-API traits), `requires`, `serves`, `cluster_plugins` (crate locator plus `process_local`/`needs_credentials`), `declared_roles`, `config_schema`, `category`, and the product-level parts of `provides`/`consumes` (rest base path, sdk, local ctor, `from_`, `critical`) |
| **discovered** on the filesystem | `docs` — PRD, DESIGN, ADRs and a checked-in `OpenAPI` document, found under `docs/` beside the gear and in its parent. Neither projected nor declared; `docs(...)` overrides only when a gear is laid out differently |
  | assigned by the loader | `source`, `gdl_path` |

- `CargoRef { crate_name, lib_ident /* MANDATORY */, path, features, default_features, link, attr }`
  — `link` is the `use X as _;` idents, allowing nested plugin module paths; `attr:
  Option<RelPath>` narrows the attribute scan and is required only when a crate declares more than
  one gear (`mini-chat` does — see §3.4.1). `RelPath` already rejects absolute paths, `..` and
  backslashes, so it needs no extra confinement check.
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
   `ClusterProviderDecl.capabilities`, which is itself projected from the `with_*_provider` calls by
   `gearbox-verify` rather than declared and diffed (ADR 0002), so a provider added in Rust cannot
   go missing from the table. Auto ranking:
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

Diagnostic ranges: `GBX01xx` GDL, `GBX02xx` catalogue assembly, `GBX03xx` topology,
`GBX04xx` binding, `GBX05xx` cluster, `GBX06xx` runtime gaps, `GBX07xx` generators.

**ADR 0002 retires five of the nine `GBX02xx` codes** already declared in
`crates/gearbox-ir/src/diagnostics.rs`, because the divergence they detect becomes unrepresentable:

| Code | Fate |
|---|---|
| `GBX0201` name, `GBX0202` deps, `GBX0203` caps, `GBX0204` provides/cluster-providers, `GBX0205` consumes | **retired** — one authority each, so there is no second value to differ from |
| `GBX0508` profile not implemented, `GBX0509` provider unprojectable, `GBX0510` backend ambiguous, `GBX0607` cluster not deployable | **added** — the cluster projection's own failure modes; see §3.4 |
| `GBX0206` gear name is not kebab of its struct ident | **survives, and matters more** — a Rust-internal inconsistency the runtime only `warn!`s about, which silently breaks the `consumer_wiring` override key |
| `GBX0207` contract suffix or trailing major disagrees | **retired** — both halves are compile errors in `toolkit-contract-macros` (`parse.rs:70` unrecognised suffix, `parse.rs:83` marker vs `version`), so a crate exhibiting either does not build and never reaches a catalogue. Replaced by a differential test pinning our suffix and marker rules to the macro's own vectors, because Gearbox now *relies* on those rules and a drift would silently skip a contract |
| `GBX0208` gear crate has no `gear.gdl` | **survives, and does real work** — with `--product`, a selected gear missing from the catalogue triggers a search for a crate declaring it; found means "here is the `gear.gdl` to write, and the `cargo(...)` line read from its manifest", not found means `GBX0301`. The tree has 44 gear attributes and 14 descriptions, so the found case is the common one |
| `GBX0209` declared lib ident does not match the crate | **survives** — `crate_name` and `lib` are the only declared facts with an external authority (`Cargo.toml`), checked at catalogue load for **every** `cargo(...)` in a description, not just `package` |

Two are added: `GBX0210` a description restates a projected fact, `GBX0211` the attribute scan found
zero or several candidates.

**One case is deliberately left unreported.** An *unmarked* trait name with `version = "v2"` or later
does compile: ADR-0007 makes an unmarked name unconstrained, because a v1 contract keeps its unmarked
name when v2 is added beside it. Reporting it would contradict the platform's own decision, and the
tree contains no instance — so it is recorded as a known gap and as an assertion in
`crates/gearbox-ir/tests/contract_shape.rs`, which is what will notice if the macro ever tightens it.

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
profile = "payments-audit"; primitive = "leader_election"
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

**Catalogue loading is staged over the wire, per §2.3.** `gearbox/catalogue/load` returns as soon as
S0/S1 are done — paths plus declared facts, with everything still unprojected listed under `pending`
— and the engine then sends `gearbox/catalogueChanged` as gears complete, carrying the gears that
moved from `pending` into the catalogue rather than the whole thing again. `$/progress` reports
completed against discovered. `$/cancelRequest` already applies to the scan; **cancelling leaves what
is already projected valid** rather than discarding it, so a cancelled load degrades to a smaller
catalogue and not to none. A response whose `pending` is non-empty is therefore normal, and a client
must not read absence of a field on a pending entry as absence of the fact.

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
| Catalogue | tree by `category` → gear; badges for `runtime_caps`, chips for `colocated_deps`, provides/consumes counts. Click reveals the `gear.gdl` at its declaring range. Checkbox produces a *proposed* `use_gear(...)` diff, never an auto-edit. **Renders incrementally** (§2.3): the grouping is available at S1 because `category` is declared, while the badges arrive at S2 because `runtime_caps` and `colocated_deps` are projected — so the tree's shape settles first and fills in. Rows are keyed by `gdl_path`, not `id`, because the id does not exist until S2. A `pending` row renders dimmed, and **clicking it still reveals its `gear.gdl`** — that path is known from S0, so a pending row is never inert. |
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
against `gearbox rpc --stdio`. Completion is context-sensitive from the engine, and only for fields
GDL still owns — `runtime_caps`, `colocated_deps` and `cluster_providers` are projected now, so
offering completions for them would invite the restatement the surface rejects. Inside `from_ = "`
catalogue gear ids; inside `profile = "` the profiles the gear's crate actually implements (which is
the join key, so completing it prevents a GBX0508 rather than reporting one); inside
`capabilities = [` the capabilities the requirement's primitive admits; inside
`cluster_plugin(backend = "` the backend impls found in that plugin crate.

---

### 9.1 What is built, and where the implementation diverged from this plan

Three widgets exist against the real engine: **Catalogue** (tree by category, staged),
**Gear detail** and **Graph (co-location)**. Product, Explain, Lock and Generate are not built,
because they need the resolver -- and the UI says so, driven by the engine's own
`capabilities.resolve: false` rather than by a hard-coded string, so the notice disappears on its
own when M4 lands.

`ide/scripts/ui-smoke.mjs` drives a headless Chrome against a running `browser-app` and asserts
**33** things, stable across repeated runs. It is deliberately a *timeline* rather than a final
state: a snapshot taken after loading would pass even if the tree had appeared all at once, which is
exactly the claim ADR-0009 makes and could not previously check. On the real tree it catches a
window of roughly 550 ms in which all 14 rows are on screen, named and grouped, and all 14 are
still `pending` -- so the staged design is not merely implemented, it is visible.

**ADR-0009 survived contact with a consumer**, with one thing learned: `gdl_path` turned out to be
load-bearing beyond keying rows. The *selection* is keyed by it too, so choosing a gear before it
is parsed does not lose the choice when it finishes. An id-keyed selection could not do that.

Divergences from what §9 planned, each for a reason found while building:

| Planned | Built | Why |
|---|---|---|
| `elkjs` `layered` with a fixed seed | hand-rolled layered assignment + two barycentre sweeps | Deterministic by construction rather than by seed, and no async layout pass. The graph is a shallow DAG of 14 nodes. If it grows a cycle or a hundred nodes, `elkjs` is the answer. |
| detail as part of the Catalogue widget | its own widget in the **bottom** area | In a 300px side panel the projected facts -- provider transports, which point a plugin fills and under which vendor, GTS types -- were clipped. The tree answers "what is there"; the detail answers "what is it", and they need different amounts of room. |
| `@theia/{core,editor,filesystem,markers,monaco,navigator,process,workspace}` | plus `@theia/{preferences,userstorage,variable-resolver,messages}` | Without `@theia/preferences` the frontend dies on `No matching bindings found for serviceIdentifier: Symbol(PreferenceProvider) - named "1"` -- the user-scope provider. Without `@theia/messages`, `MessageService` still resolves and every message goes nowhere, which is worse than an error: it makes reporting a failure look like handling it. |
| `.gdl` as a bundled VS Code extension in `ide/gdl-language/`, declared via `theiaPlugins`, with an `extension.ts` starting a `LanguageClient` | a native `LanguageGrammarDefinitionContribution` in `gearbox-studio`, whose vocabulary is **generated** from the engine's own globals | The plugin path is not available: `@theia/plugin-ext` is not installed and `ide/plugins/` does not exist, so the `--plugins=local-dir:../plugins` flag in `browser-app/package.json` is inert. Adding a plugin host to ship one grammar is a large dependency for a small feature, and there is no `LanguageClient` to start -- the engine's JSON-RPC surface is LSP-*shaped* but has no `textDocument/*`. The native path also buys something the plugin could not: `cargo test -p gearbox-gdl --test export_grammar` derives the word lists from `gear_vocabulary()` / `product_vocabulary()` and `keyword_verdicts()`, so the editor cannot colour a function the engine does not have. §9 also listed the forbidden keywords as `if/for/def/lambda/while`; the real set is wider (`and`, `or`, `not`, `in`, `elif`, `else`, `break`, `continue`, `return`, `pass`), and `while` is not in it at all -- the lexer folds it into a single `Token::Reserved` variant, so it is refused as a parse error rather than as GBX0103. It still renders red, from the second of the two generated lists. |

Three failure modes worth writing down, because all three *looked* fine:

- **`FrontendApplicationContribution.onStart` opens a view too early.** It runs before the shell is
  attached, so layout setup left the panel collapsed -- and a collapsed Theia side panel still keeps
  its widget in the DOM. The tree was queryable and invisible, and the first version of the UI check
  passed against a blank screen. `initializeLayout` is the correct hook, and it also only runs when
  there is no saved layout, so a person who closes the panel does not get it forced back open.
  The check now asserts `getClientRects().length > 0`, not node count.
- **A two-way RPC proxy plus a store that injects the service is a DI cycle.** inversify reports it
  as "circular dependency in one of the `toDynamicValue` bindings". One of the two edges has to be
  deferred; the client edge is the safe one, reached through a forwarder, because no notification
  can arrive before the store has asked for the service and started a load.
- **Theia's command palette is `.quick-input-widget`, without the `monaco-` prefix.** A selector
  that never matches is worse than no wait at all: with the timeout swallowed, the step passed or
  failed on timing. Keypresses sent while Theia is still installing its keybindings are simply lost,
  so the check presses F1 until the palette answers.

Two more failure modes surfaced once the app was actually used, both the same
shape as the three above -- something that looked fine and failed in silence:

- **The `gear.gdl` and docs links were dead.** Every path the catalogue carries
  is relative to its source root, and the root is the one thing only the engine
  knows -- `SourceDecl::location` holds the location *as the operator wrote it*,
  because it goes into `product.lock` and a lock carrying `/Users/someone/...`
  would not survive being committed. So the relative path went into
  `new URI(...)`, produced a URI with no scheme, and no opener claimed it.
  `initialize` now reports `roots: [{ id, path }]` -- an RPC fact, deliberately
  not an IR one, since the server and its client are on the same machine by
  construction while the lock has to stay portable.
- **The failure was swallowed twice.** First by an empty `catch` whose comment
  assumed the file was outside the workspace -- an assumption never checked.
  Then, after the first fix reported it through `MessageService`, by the absence
  of `@theia/messages`: the service resolves without the package, and every
  message goes nowhere. Reporting a failure looked like handling it.

The lesson for the UI check is the general one: asserting that a link *renders*
proves nothing, because the broken link rendered perfectly. It now asserts that
**a tab opens**, for `gear.gdl` and for a docs link.

A third trap, not in the UI at all: `npm run build` does not rebuild the engine.
The backend spawns `../target/debug/gearbox`, so the Rust half stays stale and
the symptom is a client reporting something the engine was already taught to
send. `npm run verify` builds it first.

Known cosmetic gap: the app has no favicon. `@theia/cli` 1.75 offers no hook for one and its
generated `index.html` has no `<link rel="icon">`. The UI check tolerates that 404 **by name**, so a
genuinely missing resource still fails.

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
| **M3** — **done** | `gearbox validate` | `gearbox validate --root ../gears-rust` → 0 errors, and with `--product` → 0 errors on the real product; GBX0208 and GBX0301 each proved against the real tree (`bss-ledger` is undescribed, `api-gatewey` is a typo); GBX0209 proved on temporary trees because the repository has no wrong declaration to point at; GBX0207 retired with a differential test in its place | M2, M8a |
| **M4** | Resolver + explain + lock | all three profiles diff clean against `fixtures/*/product.lock`; every GBX03xx–06xx code reachable; determinism loop | M8a |
| **M5** | Crate + config generators; **embedded runs** | acceptance §12 step 2 in full | — |
| **M6** | Host-workers | new gear lands and passes its own test *by hand first*; then generated worker crate; host spawns worker; remote REST binding resolves via directory | M7 |
| **M7** | Docker + Helm + `values.schema.json` | acceptance §12 step 4 in full | M6 |
| **M8a** — **done** | JSON-RPC + TS types | `node ide/scripts/rpc-smoke.mjs` drives initialize → catalogue over real framing, 15/15; `cargo test -p gearbox-rpc`; stdout carries nothing but JSON-RPC | from M1 |
| **M8b** — **partly done** (§9.1) | Theia Studio | Catalogue, Gear detail and the co-location Graph are built and checked headlessly: `cd ide && npm run verify`, 30/30. Product, Explain, Lock and Generate wait on M4 and say so in the UI | after M4 + M8a |
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

**Step 1 — validate.** Done and green:
```bash
gearbox validate --root ../gears-rust                                  # 0 errors
gearbox validate --root ../gears-rust --product products/payments-demo/product.gdl
# GBX0208: a real gear with no description, with the cargo(...) line to write
gearbox validate --root ../gears-rust --product <product selecting "bss-ledger">
# GBX0301: nothing declares it, with a spelling hint when one is close
gearbox validate --root ../gears-rust --product <product selecting "api-gatewey">
```
Then the projection checks ADR 0002 needs (all cheap, all offline):

```bash
# every projected field really came from Rust: strip the attributes' values from a
# copy of the tree, re-run, and assert the catalogue changes rather than not noticing
gearbox catalogue --root ../gears-rust --format json > /tmp/base.json

# restatement is refused, once per projected field
for f in id runtime_caps colocated_deps lifecycle client_trait; do
  gearbox validate --root fixtures/negative/restate-$f 2>&1 | grep -q GBX0210 || echo "MISS $f"
done

# the attribute locator: mini-chat is the positive case (3 gears, 1 crate)
gearbox catalogue --root ../gears-rust --format json   | jq -r '.gears | keys[] | select(startswith("static-mini-chat") or . == "mini-chat")' | sort   | diff - <(printf 'mini-chat\nstatic-mini-chat-audit-plugin\nstatic-mini-chat-model-policy-plugin\n')
gearbox validate --root fixtures/negative/attr-ambiguous 2>&1 | grep -q GBX0211
gearbox validate --root fixtures/negative/attr-missing   2>&1 | grep -q GBX0211
```

The load-bearing one is the `mini-chat` diff: it is the only case in the repository that proves the
locator does real work rather than defaulting its way to a right answer.

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

**Step 9 — Studio.** `cd ide && npm ci && npm run verify` (rpc smoke, build, then the headless UI
check against a running app -- `npm run start:browser` in another shell first). The catalogue,
detail and co-location graph assertions are automated and green; the ones below still need M4:
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
a decision"). The set worth writing, as `docs/ADR/NNNN-cpt-gearbox-adr-<slug>.md`. **0002 and 0009 are the
exceptions to "after the prototype runs"** — 0002 decides what M2 builds and 0009 what M8 builds, so
both are written first; the rest of the numbering below is kept as reserved slots:

| # | Slug | The dilemma |
|---|---|---|
| 0001 | `gdl-starlark-over-toml` | vision says Starlark; the repo-grounded predecessor says TOML + syn and calls Starlark "a language subsystem with no consumer". Record why the prototype chose Starlark *and* what would justify reverting. |
| 0002 | `macro-projected-catalogue` | **Written already**, ahead of M2 rather than at M9, because it constrains the GDL surface and the scanner before either exists — see `docs/ADR/0002-cpt-gearbox-adr-macro-projected-catalogue.md`. Records why the macro keeps every fact it already expresses, why GDL declares only the disjoint remainder, and the three rejected alternatives (GDL-authoritative-with-cross-check, GDL-generates-the-annotations, macro-only). Includes the three-confidence-level model that was rejected. |
| 0003 | `colocation-is-a-closure-not-a-partition` | the `MissingDeps` finding, why `deps` edges are uncuttable, and why processes overlap. The most consequential correction to the vision. |
| 0004 | `product-lock-canonical-serialization` | TOML + `blake3` over the body, `lock_hash` elided; why arrays-of-tables and BTreeMap iteration are load-bearing, not cosmetic. |
| 0005 | `rpc-jsonrpc-stdio-lsp-framing` | stdio LSP framing vs local HTTP vs WASM; why one server backs both the Studio and the `.gdl` language client. |
| 0006 | `template-text-serialize-data` | minijinja for text, serde for data, `<< >>` for Helm sources; the YAML-indentation failure mode being avoided. |
| 0007 | `k8s-static-endpoint-resolution` | no K8s-DNS `EndpointResolver` exists; ConfigMap-pinned `consumer_wiring` + GBX0603 vs waiting for a runtime feature vs faking it. |
| 0008 | `unsupported-is-a-diagnostic-not-an-omission` | roles/shards/providers/profiles are parsed and then explicitly refused with cited evidence, rather than being absent from the grammar. |
| 0009 | `staged-catalogue-loading` | **Written already**, because it constrains the RPC surface and the Catalogue widget before either exists. Five stages with measured costs; why "not yet computed" is a separate `pending` list rather than tri-state fields or a `stage` on the gear; and why the projected `GearId` makes staging a requirement rather than an improvement — see `docs/ADR/0009-cpt-gearbox-adr-staged-catalogue-loading.md`. |

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
