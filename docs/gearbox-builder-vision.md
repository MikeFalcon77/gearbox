# Gearbox Builder
## Vision for a Gears Product Composition, Resolution, and Deployment System

**Status:** Vision / pitch document  
**Working name:** **Gearbox Builder**  
**Scope:** Product vision and architectural direction, not a detailed implementation design  
**Date:** 2026-08-26

---

# 1. Executive Summary

Gears already provides a modular Rust platform with gears, contracts, local and out-of-process execution, discovery, runtime wiring, deployment profiles, and cluster primitives.

What is still missing is a first-class way to define a **product**.

Today, product composition is distributed across Cargo features, handwritten registration code, deployment manifests, Helm charts, runtime configuration, and developer knowledge about which gears can or cannot be separated.

**Gearbox Builder** is the proposed product composition layer for Gears.

Its purpose is to let a developer or integrator express:

- which gears belong to a product;
- which deployment profile is desired;
- which gears or roles should be replicated or sharded;
- which infrastructure already exists;
- which capabilities are required;
- which provider choices are explicit and which are automatic;
- which policies/preferences should guide automatic choices.

Gearbox Builder then deterministically derives a valid concrete product:

- the process/pod topology;
- local vs remote contract bindings;
- contract compatibility;
- required transports and discovery;
- cluster primitive providers;
- per-instance addressing requirements;
- build graph;
- generated process crates;
- container images;
- Helm deployment artifacts;
- documentation and other derived outputs.

The central product principle is:

> **Configure intent. Derive implementation.**

The central architecture principle is:

> **`gear.gdl` is the single source of truth for Gear product metadata.  
> Starlark is the authoring runtime.  
> Rust IR is the model.  
> The Rust resolver is the authority.  
> `product.lock` is the resolved product snapshot.  
> GUI, TUI, CLI, and MCP are clients of the same engine.**

Gearbox Builder is designed to be **AI-native, but not AI-dependent**.

External AI agents can control it through MCP and skills, but no LLM is involved in correctness or resolution.

---

# 2. Why This Exists

Gears is evolving from a framework into a platform from which multiple products and deployments can be assembled.

That creates a product-line problem.

A product is no longer simply:

```text
cargo build --features foo,bar,baz
```

A real product has relationships and constraints:

```text
Gear A consumes Contract X
Gear B provides Contract X

Gear C requires:
    Linearizable Cache
    Prefix Watch

Deployment = Kubernetes

Role ingest:
    sharded
    replicas = 3
    requires stable instance addressing

Public API:
    exposed through an edge provider
```

The correct concrete implementation depends on all of these facts together.

Examples:

- a contract may be local in Embedded and remote in Kubernetes;
- a local-only extension contract cannot cross a process boundary;
- an Event Broker shard may require per-instance addressability;
- a leader-election requirement can potentially be satisfied by a Kubernetes Lease while cache is provided by Redis or PostgreSQL;
- a remote critical dependency must affect readiness but must not become a global startup dependency;
- an explicit provider override must still satisfy the required capabilities.

Today, humans make many of these decisions manually.

That does not scale.

---

# 3. Product Vision

Gearbox Builder should make the following scenario routine:

```text
1. Choose existing Gears components.
2. Add a custom Gear.
3. Describe the product.
4. Select a deployment profile:
       embedded
       host-workers
       kubernetes
5. Resolve the product.
6. Inspect why every important decision was made.
7. Generate build and deployment artifacts.
8. Change deployment profile without changing Gear source code.
```

This is the canonical acceptance scenario.

The same Gear source should be usable across all supported deployment profiles wherever its declared semantics permit it.

That is a core promise of the system:

> **Deployment topology should change composition and binding, not business code.**

---

# 4. Why “Gearbox Builder”

The working name is **Gearbox Builder**.

It communicates the intended abstraction well:

- Gears are reusable mechanisms/components.
- Gearbox Builder assembles them into a working system.
- The result is more than a list of parts: relationships, compatibility, constraints, and topology matter.

The name is preferable for a pitch to a generic “Gears Configurator”, which sounds like a settings editor rather than a product-composition system.

The internal CLI/tool names can still use existing naming conventions such as:

```text
cargo gears ...
```

The product name and executable names do not need to be identical.

---

# 5. What Gearbox Builder Is

Gearbox Builder is a **software product-line configurator and resolver** for Gears.

Conceptually, it is closer to:

- eCos CDL;
- Kconfig;
- Bazel-style declarative composition;
- a package/dependency resolver;
- a deployment planner;

than to a normal configuration editor.

It operates over:

```text
Components
Contracts
Requirements
Capabilities
Providers
Deployment topology
Roles
Shards
Preferences
Policies
```

and produces a valid resolved product.

---

# 6. What Gearbox Builder Is Not

Gearbox Builder is not:

- a replacement for Cargo;
- a replacement for Kubernetes;
- a replacement for Helm;
- a general-purpose programming language;
- a runtime service mesh;
- an AI agent;
- a chat UI;
- an OPA/Rego policy engine;
- a generic infrastructure-as-code system;
- a second implementation of Gears runtime semantics.

It sits above existing mechanisms and composes them.

---

# 7. High-Level Architecture

```text
                    Gear definitions
                      gear.gdl
                         |
                         v
                 +----------------+
                 | GDL evaluator  |
                 |   Starlark     |
                 +-------+--------+
                         |
                         v
                  Typed Rust IR
                         |
              +----------+----------+
              |                     |
        Product Catalogue      Product Intent
              |                     |
              +----------+----------+
                         |
                         v
                +-------------------+
                | Rust Resolver     |
                |                   |
                | dependency graph  |
                | contract graph    |
                | capabilities      |
                | providers         |
                | placement         |
                | topology          |
                | preferences       |
                | diagnostics       |
                | explanation graph |
                +---------+---------+
                          |
                          v
                    product.lock
                          |
          +---------------+----------------+
          |               |                |
          v               v                v
        Build          Deployment        Tooling
        outputs          outputs          outputs

      Cargo crates         Helm             CLI
      binaries             images           TUI
      Dockerfiles          Services         GUI
      SBOM                 config           MCP
      docs                 schemas
```

The core engine does not depend on CLI, GUI, TUI, or AI.

---

# 8. One Source of Truth for Gear Product Metadata

A major decision is to avoid spreading product metadata across:

```text
gear.toml
Cargo.toml metadata
Rust macros
YAML
Starlark
Helm values
```

That creates inevitable drift.

Instead:

> **Every Gear has one authoritative `gear.gdl`.**

`gear.gdl` describes all Gear-level metadata relevant to product composition.

Example:

```python
gear(
    id = "contracts-agreements",

    name = "Contracts & Agreements",

    description = """
        System of Record for signed commercial terms,
        negotiated prices, and commitments.
    """,

    category = "bss",

    kind = service(
        has_extension_point = True,
    ),

    package = cargo(
        crate = "contracts-agreements",
    ),
)
```

This replaces descriptive metadata currently represented in forms such as:

```toml
[gear]
name = "Contracts & Agreements"
description = "System of Record for signed commercial terms, negotiated prices, and commitments."
category = "bss"
is_plugin = false
has_plugins = false
has_extension_point = true
```

---

# 9. Stable Identity vs Display Metadata

A Gear should have a stable machine identity distinct from its display name.

Prefer:

```python
gear(
    id = "contracts-agreements",
    name = "Contracts & Agreements",
)
```

not:

```text
id = "Contracts & Agreements"
```

The stable ID is used by:

- dependencies;
- contracts;
- product composition;
- lock files;
- MCP;
- generated artifacts;
- references across repositories.

Display text may change without breaking references.

---

# 10. GDL: Gears Description Language

The proposed authoring language is called **GDL — Gears Description Language**.

GDL is **not a new parser or programming language**.

It is:

> **a strongly constrained Gears domain API hosted in Starlark.**

File examples:

```text
gear.gdl
product.gdl
providers.gdl
presets.gdl
```

Syntax/runtime:

```text
Starlark
```

Domain model:

```text
Gears
```

This is similar in spirit to Bazel BUILD files: the underlying language is Starlark, while users interact with a domain-specific API.

---

# 11. Why Starlark

Starlark is preferred over inventing a custom language.

It already provides:

- deterministic execution;
- hermetic behavior;
- familiar Python-like syntax;
- functions;
- modules;
- comprehensions;
- reusable helpers/macros;
- mature parser/runtime tooling;
- source locations and diagnostics;
- a strong Rust implementation ecosystem.

Most importantly, it avoids turning the Gears team into accidental language-tooling maintainers.

---

# 12. GDL Must Remain Declarative

Starlark is the syntax and composition mechanism, but **resolution semantics must not move into Starlark scripts**.

Good:

```python
gear(
    id = "event-broker",

    requires = [
        cluster.cache(
            capabilities = [
                "linearizable",
                "prefix-watch",
            ],
        ),
    ],
)
```

Bad:

```python
if deployment == "kubernetes":
    if redis_available:
        choose_redis()
    else:
        choose_postgres()
```

The first describes facts and intent.

The second implements the resolver in configuration scripts.

That would destroy determinism, consistency, and explainability.

---

# 13. Rust IR Is the Canonical Model

GDL evaluates into typed Rust objects.

After evaluation, the rest of Gearbox Builder works entirely with Rust types.

Conceptually:

```rust
struct Catalogue {
    gears: Vec<GearDescriptor>,
    contracts: Vec<ContractDescriptor>,
    providers: Vec<ProviderDescriptor>,
}

struct ProductIntent {
    deployment: DeploymentProfile,
    gears: Vec<GearSelection>,
    placements: Vec<PlacementIntent>,
    overrides: Vec<ProviderOverride>,
    preferences: Vec<Preference>,
}

struct ResolvedProduct {
    gears: Vec<ResolvedGear>,
    processes: Vec<ResolvedProcess>,
    bindings: Vec<ResolvedBinding>,
    providers: Vec<ResolvedProvider>,
    requirements: Vec<ResolvedRequirement>,
    diagnostics: Vec<Diagnostic>,
    explanations: ExplanationGraph,
}
```

Exact types and naming belong in the detailed design.

The important boundary is:

```text
GDL -> typed Rust IR
```

After that, Starlark should not leak into the rest of the architecture.

---

# 14. Three Core Representations

The system must keep three concepts separate.

## 14.1 Catalogue

Developer-owned facts:

```text
what exists
what it provides
what it consumes
what it requires
what topologies it supports
what roles it has
what capabilities providers expose
```

## 14.2 Intent

User/operator choices:

```text
what is enabled
deployment profile
replicas
desired placement
provider overrides
preferences
source/version selections
```

## 14.3 ResolvedProduct

Derived implementation:

```text
actual process topology
actual local/remote bindings
actual providers
transport choice
addressability requirements
deployment requirements
generated artifact inputs
```

This split is fundamental.

---

# 15. `gear.gdl` Owns Gear Composition Metadata

A Gear descriptor may include:

```text
identity
name
description
category

kind
plugin/extensibility model

Cargo package mapping

provided contracts
consumed contracts

hard dependencies

roles
shard semantics

capability requirements

deployment constraints

product visibility

configuration schema references
```

Illustrative example:

```python
gear(
    id = "event-broker",

    name = "Event Broker",
    description = "Distributed event delivery service.",
    category = "platform",

    kind = service(),

    package = cargo(
        crate = "event-broker",
    ),

    provides = [
        contract(
            "EventBrokerApiV1",
            rust = "event_broker_sdk::EventBrokerApiV1",
        ),
    ],

    consumes = [
        contract(
            "TenantResolverApiV1",
            rust = "tenant_resolver_sdk::TenantResolverApiV1",
            from_ = "tenant-resolver",
            critical = True,
        ),
    ],

    roles = [
        role(
            "dispatcher",
            directory_name = "event-broker",
        ),

        role(
            "ingest",
            directory_name = "event-broker-ingest",
            sharded = True,
            instance_addressable = True,
        ),

        role(
            "delivery",
            directory_name = "event-broker-delivery",
        ),
    ],

    requires = [
        cluster.cache(
            capabilities = [
                "linearizable",
                "prefix-watch",
            ],
        ),

        cluster.leader_election(
            capabilities = [
                "linearizable",
            ],
        ),
    ],
)
```

The exact GDL syntax is intentionally illustrative.

---

# 16. Rust Still Defines Contract Contents

Making `gear.gdl` authoritative for product metadata does **not** mean redefining Rust interfaces in GDL.

Rust remains the source of truth for the contract itself:

```rust
pub trait ContractsApiV1 {
    async fn get_contract(...);
    async fn sign_contract(...);
}
```

GDL declares the relationship:

```text
contracts-agreements provides ContractsApiV1
```

These are different facts.

Therefore:

```text
Rust:
    defines and implements the contract

GDL:
    declares product-level use of that contract
```

The GDL compiler/tooling should validate that referenced Rust contracts exist and are compatible with the declaration.

---

# 17. GDL Can Replace Duplicate Rust Composition Annotations Over Time

If the same information is represented in both:

```rust
#[toolkit::consumes(...)]
```

and:

```python
consumes = [...]
```

then drift is inevitable.

The preferred long-term direction is:

```text
gear.gdl
   |
   +--> product catalogue
   +--> generated registration glue
   +--> compile-time validation
```

Rather than manually repeating the same product relationship in Rust.

Possible generated Rust glue:

```rust
register_consumer::<billing_sdk::BillingApiV1>("billing");
```

or a generated descriptor/registration table.

Migration from current macros should be incremental and validated against the real repository before detailed design is finalized.

---

# 18. Product Composition in `product.gdl`

Existing Gear definitions describe what components are.

`product.gdl` describes what the user wants.

Example:

```python
product(
    id = "cyber-protect",

    deployment = kubernetes(),

    gears = [
        use("event-broker"),
        use("contracts-agreements"),
        use("tenant-resolver"),
    ],

    preferences = [
        prefer_existing_infrastructure(),
    ],
)
```

This is intentionally much smaller than repeating Gear definitions.

---

# 19. Source Resolution: Path, Git, Registry

A product must be able to obtain Gears from different locations.

This should be independent of GDL semantics.

Supported source model:

```text
path
git
registry
```

Example:

```python
product(
    gears = [
        use(
            "my-gear",
            source = path("../my-gear"),
        ),

        use(
            "mini-chat",
            source = git(
                "ssh://git/.../gears-rust",
                tag = "v0.6.1",
            ),
        ),
    ],
)
```

Later:

```python
source = registry(
    package = "cf-gears-mini-chat",
    version = "^0.7",
)
```

All source types eventually produce a local source tree containing:

```text
gear.gdl
Cargo.toml
src/
...
```

---

# 20. Why Git Support Matters Early

A private registry should not be a prerequisite for the configurator.

Git already provides:

- source retrieval;
- private repository access;
- tag/revision pinning;
- reproducible source snapshots.

The resolved lock file should pin the exact revision:

```text
source = git
rev = 8ac3e7...
```

A future registry can add semver resolution without changing the core product model.

---

# 21. `product.lock`: The Center of the Resolved Product

One of the strongest ideas from earlier exploration is:

> **Gearbox Builder should behave like “Cargo for products”.**

The central resolved artifact is:

```text
product.lock
```

This is not human-authored intent.

It is written by the resolver.

It captures the exact resolved product.

---

# 22. What `product.lock` Contains

Examples:

```text
product identity
deployment profile

exact Gear source revisions/versions

enabled Gears

resolved process topology

replica counts

roles and shards

local/remote contract bindings

contract identities and versions

selected transports

provider selections

selected vs resolved automatic choices

derived requirements

deployment requirements

explanation/provenance references
```

Example:

```toml
[product]
name = "my-product"
deployment = "kubernetes"

[[process]]
name = "mini-chat"
gears = ["mini-chat", "types-registry"]
replicas = 3

[[binding]]
consumer = "mini-chat"
contract = "AuthnApiV1"
provider = "authn-resolver"
mode = "remote"
transport = "rest"
critical = true

[[cluster]]
scope = "event-broker"
primitive = "leader-election"
selected = "auto"
resolved = "k8s-lease"
```

The exact serialization format is a detailed-design question.

The conceptual role is not.

---

# 23. Why `product.lock` Is Important

Every downstream generator should consume the same resolved product.

```text
product.gdl
     |
     v
 resolver
     |
     v
 product.lock
     |
     +--> Cargo
     +--> binaries
     +--> Dockerfiles
     +--> Helm
     +--> docs
     +--> SBOM
     +--> architecture diagrams
```

This avoids separate implementations of resolution in every renderer.

It also makes product changes diffable.

---

# 24. Deployment Profiles

Gears intentionally defines three main deployment topologies:

```text
embedded
host-workers
kubernetes
```

Gearbox Builder should model these as explicit finite choices.

Use the term:

```text
DeploymentProfile
```

Do not overload the word “profile” for unrelated concepts.

---

# 25. Product Presets Are Different

Examples:

```text
dev
minimal
production
```

These are **presets**, not deployment profiles.

A preset is an intent overlay or preference bundle.

For example:

```python
preset(
    "production",

    preferences = [
        require_high_availability(),
        prefer_external_state(),
    ],
)
```

A production preset could potentially be used with multiple deployment profiles.

---

# 26. Cluster Profile Is Also Different

The cluster subsystem currently uses `ClusterProfile` to identify a logical scope such as:

```text
event-broker
```

This is neither:

- a DeploymentProfile;
- nor a product preset.

In Gearbox Builder’s IR/UI, a clearer semantic name may be:

```text
ClusterScope
```

even if the runtime API keeps the existing name.

---

# 27. Deployment Changes Binding, Not Business Code

The same contract relationship can resolve differently by topology.

Example:

```text
Orders consumes BillingApi
Billing provides BillingApi
```

## Embedded

```text
Orders + Billing
same process

binding:
    local
transport:
    none
discovery:
    none
```

## Kubernetes

```text
Orders pod
Billing pod

binding:
    remote
transport:
    REST or gRPC
discovery:
    required
readiness:
    eventual
```

The user should not manually specify `local = true/false`.

It is derived from placement.

---

# 28. Contract Graph Is First-Class

The product cannot be modeled only as:

```text
Gear -> Gear
```

because one Gear can expose multiple contracts.

The model must include:

```text
Consumer -> Contract -> Provider
```

Example:

```text
Orders
   |
   | consumes
   v
BillingApiV2
   ^
   | provides
   |
Billing
```

This enables static compatibility validation.

---

# 29. Contract Versions

If:

```text
orders consumes BillingApiV2
```

but:

```text
billing provides BillingApiV1 only
```

then the resolver can fail before deployment:

```text
ERROR:
BillingApiV2 is required by orders,
but billing only provides BillingApiV1.
```

This is valuable even if runtime discovery does not yet fully encode contract identity.

---

# 30. Hard Dependencies vs Contract Consumption

These are different relationships.

## Hard dependency

Meaning:

```text
must be co-located
affects process startup/lifecycle
```

## Contract consumption

Meaning:

```text
consumer needs a contract
provider may be local or remote
remote binding may become ready later
```

Never collapse both into:

```text
depends_on
```

That would destroy important deployment semantics.

---

# 31. Contract Kind Creates Placement Constraints

Existing contract categories such as:

```text
Api
Embedded
Backend
Extension
```

imply topology constraints.

For example, a local-only extension contract cannot cross process boundaries.

Gearbox Builder should detect this statically.

Example diagnostic:

```text
FooExtension is local-only.

consumer:
    plugin-manager

provider:
    foo-extension

placement:
    different processes

Possible fixes:
    colocate components
    select a remote-capable contract
    change deployment topology
```

---

# 32. Eventual Readiness Is Runtime Semantics

Remote dependencies should not be turned into a global startup graph.

For multi-process deployments:

```text
processes start independently
remote dependencies resolve asynchronously
critical dependencies gate readiness
```

Gearbox Builder may derive:

```text
binding = remote
critical = true
readiness-gating = true
```

but the runtime remains responsible for eventual readiness.

---

# 33. Roles and Shards

Role and shard semantics are first-class product metadata.

Example Event Broker structure:

```text
event-broker

roles:
    dispatcher
    ingest
    delivery
```

Role-specific APIs may map to different logical directory names:

```text
dispatcher -> event-broker
ingest     -> event-broker-ingest
delivery   -> event-broker-delivery
```

Shards are a separate dimension.

Conceptually:

```text
role:
    directory name

shard:
    labels / instance selection
```

Avoid reintroducing a generic `entrypoint` flag.

---

# 34. Embedded Topology Has Structural Limits

Some role/shard layouts cannot exist in Embedded mode.

Example:

```text
deployment = embedded
event-broker.ingest.replicas = 3
event-broker.ingest.sharded = true
```

If the runtime semantics require separately addressable role/shard instances, the configuration is invalid.

Diagnostic:

```text
Event Broker ingest sharding requires
instance-addressable role-separated deployment.

Embedded cannot represent this topology.

Supported alternatives:
    host-workers
    kubernetes
```

---

# 35. Per-Instance Addressability Is a Requirement

Do not encode:

```text
use StatefulSet
```

as the semantic requirement.

Encode:

```text
PerInstanceAddressable
```

The deployment generator can then realize it with a supported mechanism such as:

- StatefulSet + headless Service;
- a self-registering workload;
- another future mechanism.

This keeps semantics separate from renderer implementation.

---

# 36. Cluster Primitives Are a Natural Capability System

The existing cluster design already resembles the intended resolver.

Primitives include concepts such as:

```text
Cache
LeaderElection
DistributedLock
```

Consumers require capabilities:

```text
Linearizable
PrefixWatch
```

Providers expose capabilities.

Gearbox Builder should resolve:

```text
Requirement -> Provider capabilities
```

before runtime.

---

# 37. Cluster Provider Choice Is Per Primitive

Do not define:

```text
cluster.provider = redis
```

as a global concept.

Mixed configurations are valid and useful.

Example:

```text
cache             -> Redis
leader election   -> Kubernetes Lease
distributed lock  -> Redis
```

or:

```text
cache             -> PostgreSQL
leader election   -> SDK implementation over cache
distributed lock  -> PostgreSQL advisory locks
```

depending on actual provider capabilities and availability.

---

# 38. Automatic Selection

The UI and GDL should support:

```text
Automatic
```

for provider choices.

Example:

```python
cluster(
    cache = auto(),
    leader_election = auto(),
    lock = auto(),
)
```

The resolver chooses a valid implementation.

---

# 39. Selected vs Resolved

This distinction must be preserved.

User intent:

```text
leader-election = automatic
```

Resolved result:

```text
leader-election = Kubernetes Lease
```

Represent:

```text
selected:
    Automatic

resolved:
    K8s Lease
```

This concept can generalize beyond cluster primitives.

---

# 40. Hard Constraints vs Preferences

The resolver must distinguish:

## Hard constraints

Example:

```text
cache must support PrefixWatch
```

## Preferences

Example:

```text
prefer existing infrastructure
avoid adding external stateful systems
prefer deployment-native services
```

A hard constraint determines validity.

A preference chooses among multiple valid candidates.

---

# 41. Do Not Overbuild Scoring Too Early

Early repository analysis found only a small number of real cluster providers in the current implementation.

Therefore the first resolver may not need a sophisticated optimization engine.

V1 can begin with:

```text
valid / invalid
deterministic candidate choice
simple priority rules
```

and add richer scoring when there are actually multiple meaningful valid alternatives.

The architecture should allow preferences without requiring an elaborate solver on day one.

---

# 42. Generic Requirement / Capability Model

The cluster model suggests a system-wide abstraction.

Possible requirements:

```text
RemoteCallable
LocalOnly
PerInstanceAddressable
ServiceDiscovery
PublicIngress
PlatformIdentity

LinearizableCache
PrefixWatch
LeaderElection
DistributedLock
```

Possible providers:

```text
REST projection
    provides RemoteCallable

Kubernetes workload strategy
    provides PerInstanceAddressable

Redis provider
    provides Cache
    provides LinearizableCache
    provides PrefixWatch

Kubernetes Lease
    provides LeaderElection
```

This could keep the resolver generic instead of accumulating subsystem-specific branching.

---

# 43. Resolver Responsibilities

The deterministic Rust resolver should handle:

```text
dependency closure
contract compatibility
placement constraints
process grouping
local/remote binding derivation
transport selection
capability matching
provider selection
deployment requirements
role/shard constraints
automatic defaults
preferences
diagnostics
explanation provenance
```

---

# 44. Resolver Implementation Strategy

Do not begin with SAT/SMT unless the actual problem requires it.

A practical V1 can use:

```text
typed graph traversal
constraint propagation
candidate filtering
exact-one selection
deterministic priorities
simple preferences
```

The system should still define its own constraint IR so a more sophisticated solver could be added later.

---

# 45. Explainability Is a Product Feature

Every important automatic choice should answer:

```text
Why?
```

Example:

```text
Why was K8s Lease selected for leader election?
```

Structured answer:

```text
K8s Lease

Required because:
    Event Broker requires linearizable leader election.

Valid because:
    Kubernetes Lease satisfies LeaderElection.Linearizable.

Preferred because:
    deployment = Kubernetes
    no additional infrastructure is required.

Alternatives:
    PostgreSQL/SDK
    etcd
```

The resolver should build provenance **during resolution**, not attempt to reconstruct it later.

---

# 46. Explanation Graph

Conceptually:

```text
K8sLease
   selected because
       Requirement:
           LeaderElection.Linearizable

   preferred because
       Deployment:
           Kubernetes

       Preference:
           MinimizeAdditionalInfrastructure
```

This graph can be consumed by:

- CLI;
- GUI;
- TUI;
- MCP;
- AI agents.

---

# 47. Canonical Build Output: Generated Process Crates

One important earlier observation remains valuable:

A major obstacle to “Gear = process/pod” is not necessarily runtime support.

It is the burden of manually creating and maintaining many application crates.

Gearbox Builder can generate them.

Example:

```text
.gears/
    mini-chat/
        Cargo.toml
        main.rs
        registered_gears.rs

    authn-resolver/
        Cargo.toml
        main.rs
        registered_gears.rs

    event-broker-ingest/
        Cargo.toml
        main.rs
        registered_gears.rs
```

Each resolved process becomes a generated build target.

---

# 48. Process Topology Is a Resolver Output

Example `product.lock` concept:

```toml
[[process]]
name = "mini-chat"
gears = ["mini-chat", "types-registry"]
replicas = 3

[[process]]
name = "authn-resolver"
gears = ["authn-resolver"]
replicas = 2
```

Hard/co-location dependencies determine process grouping.

Remote-capable contract edges can cross those process boundaries.

---

# 49. Build Artifacts

The resolved product can generate:

```text
Cargo.toml per process
main.rs
registered_gears.rs
Dockerfile per image
Cargo feature/package selection
CI build matrix
SBOM
```

Not all outputs need to exist in MVP.

---

# 50. Deployment Artifacts

Potential generated outputs:

```text
Helm umbrella chart
subcharts/components
Deployment/StatefulSet shapes
Services
RBAC
ServiceAccounts
ConfigMaps
values.generated.yaml
values.schema.json
Docker image references
```

The generator consumes `ResolvedProduct`.

It should not make independent semantic decisions.

---

# 51. Text Templates vs Structured Serialization

A valuable implementation rule from earlier analysis:

> **Template text. Serialize data.**

Use a text template engine where text generation is natural:

```text
Dockerfile
generated main.rs
possibly Helm template source
```

Use serde/structured serialization for:

```text
product.lock
values.generated.yaml
values.schema.json
Chart.yaml
machine-readable metadata
```

Do not template YAML structures unless necessary.

---

# 52. Helm and Template Delimiters

Helm itself uses:

```text
{{ ... }}
```

A Jinja-compatible generator using the same delimiters will conflict.

If MiniJinja or similar is used for Helm template source generation, use alternative delimiters for the outer generator, for example:

```text
<< ... >>
```

so Helm expressions remain untouched.

---

# 53. Helm Generator Principles

Generated Helm should follow conventional enterprise-friendly patterns.

## 53.1 `values.schema.json`

Every generated chart should provide machine-validated values schemas.

The resolver/generator knows:

```text
field exists
field type
whether field is required
```

The operator supplies environment-specific values.

---

# 54. Existing Infrastructure Pattern

External infrastructure should be easy to reuse.

Example pattern:

```text
postgresql.enabled = false

externalDatabase.host = ...
externalDatabase.existingSecret = ...
```

This allows the same generated product to integrate into an existing cluster rather than always deploying bundled dependencies.

---

# 55. Secrets

Generated defaults should not contain application secrets.

Prefer:

```text
existingSecret
```

and integrate with the operator’s secret-management mechanism:

```text
External Secrets Operator
Sealed Secrets
SOPS
Vault
other enterprise tooling
```

---

# 56. Helm Escape Hatches

Generated charts should expose standard integration controls such as:

```text
nameOverride
fullnameOverride

global.imageRegistry
global.imagePullSecrets

podAnnotations
nodeSelector
tolerations
affinity
resources

extraEnv
extraVolumes

serviceAccount.create
serviceAccount.name

podSecurityContext
```

The exact supported surface belongs in detailed design.

---

# 57. Render Without Cluster Access

Charts should render deterministically without requiring access to the Kubernetes API.

Avoid generators that rely on live-cluster state during rendering.

This preserves:

```text
GitOps diffs
offline validation
reproducibility
CI rendering
```

---

# 58. Generated vs Operator-Owned Values

Keep generated semantic values separate from human/environment overrides.

Possible model:

```text
values.generated.yaml
    generated from product.lock

values.yaml
    operator-owned
```

Regeneration must not destroy operator values.

---

# 59. GUI and TUI

The core design supports both:

```text
Tauri GUI
ratatui TUI
```

but neither contains semantic logic.

Both are clients of the Rust engine.

---

# 60. Suggested GUI Structure

```text
Product
├── Deployment
├── Gears
├── Contracts
├── Cluster
├── Edge
├── Security
└── Artifacts
```

A graph view can show:

```text
consumer -> contract -> provider
```

and:

```text
hard co-location edges
remote-capable contract edges
```

---

# 61. “Why?” in the UI

A details pane could display:

```text
BillingApiV1

Consumer:
    orders

Provider:
    billing

Binding:
    REST

Why remote?
    orders and billing are in different Kubernetes pods

Discovery:
    DirectoryService / deployment-specific resolver

Readiness:
    critical dependency

Transport:
    HTTP

Contract:
    BillingApiV1
```

Explainability should not depend on an LLM.

---

# 62. TUI

A compact TUI can expose:

```text
components
enabled state
contracts
requires
provides
diagnostics
why
validate
save
```

This is useful in SSH/CI/platform-engineering environments.

---

# 63. Do Not Put an AI Chat Into GUI/TUI

Current direction:

> **Do not embed an LLM chat as a core Gearbox Builder feature.**

Reasons:

```text
model/provider integration
API credentials
streaming
conversation state
tool loops
prompt injection surface
permissions
duplicate UX with existing developer agents
```

Developers already work inside AI-enabled editors and agents.

Gearbox Builder should expose the engine to those agents instead.

---

# 64. MCP Is the Agent Interface

Gearbox Builder should expose a first-class MCP adapter over the Rust engine.

Architecture:

```text
                    Rust config-engine
                         |
         +---------------+---------------+
         |               |               |
        CLI             TUI             GUI

                         |
                         v
                    MCP adapter
                         |
           +-------------+-------------+
           |             |             |
      Claude Code      ChatGPT       Cursor
           |             |             |
           +-------- external agents ---+
```

Agents are clients.

They are not part of the product authority.

---

# 65. MCP Wraps the Engine, Not the CLI

Avoid:

```text
MCP
  ->
shell command
  ->
CLI
  ->
engine
```

Prefer:

```text
MCP adapter
    ->
Rust engine API
```

This preserves typed semantics and structured errors.

---

# 66. Potential MCP Operations

Illustrative:

```text
product.inspect
product.resolve
product.validate
product.explain

gear.inspect
gear.enable
gear.disable

deployment.set

cluster.inspect_requirements
cluster.bind_provider

config.get
config.propose
config.diff
config.apply

artifact.preview
artifact.generate
```

The exact API follows the detailed Rust model.

---

# 67. Proposal-Based Agent Writes

AI agents should not primarily edit arbitrary YAML/TOML/GDL files directly.

Prefer a transaction/proposal model.

Example:

```text
Agent request:
    Make Event Broker HA on Kubernetes.

Proposal #42:

+ deployment = kubernetes
+ event-broker.ingest.replicas = 3
+ event-broker.ingest.sharded = true
+ cluster.leader-election = auto

Resolved:
    leader-election -> K8s Lease

Validation:
    OK
```

Then:

```text
review
diff
apply
```

---

# 68. Skills Live Outside the Engine

Skills are agent workflows.

Examples:

```text
configure-ha-kubernetes
configure-on-prem
minimize-infrastructure
harden-production
migrate-contract-v1-v2
diagnose-wiring
configure-cluster
review-product-config
generate-deployment
```

They operate through MCP tools.

They do not own configuration semantics.

---

# 69. Tool vs Skill

## Tool

Primitive typed operation:

```text
set_deployment
bind_cluster_provider
inspect_contract
validate
```

## Skill

Workflow:

```text
configure-ha-kubernetes
```

This keeps the engine stable while AI workflows evolve.

---

# 70. LLM Responsibility

AI is valuable for two jobs.

## 70.1 Human intent -> formal intent

User:

```text
Give me a cheap single-node development setup
with no external infrastructure.
```

LLM derives:

```text
deployment = embedded
availability = development
preference = minimize external infrastructure
```

The resolver determines the concrete product.

## 70.2 Explanation

The resolver returns structured provenance.

The LLM can rewrite it conversationally.

The rule is:

```text
resolver decides
LLM explains
```

not:

```text
LLM decides
LLM justifies itself
```

---

# 71. GUI as Control Plane for External AI

Even without embedded chat, the GUI can display proposals created by external agents.

Example:

```text
External proposal

Source:
    Claude Code

Deployment:
    Host+Workers -> Kubernetes

Event Broker:
    ingest replicas 1 -> 3

Cluster:
    Leader Election
        Automatic -> K8s Lease

Status:
    valid
```

This is potentially more useful than embedding a separate chat window.

---

# 72. Rego / OPA Is a Policy Layer, Not the Product Language

Rego is useful later for organization-specific policy.

Architecture:

```text
ResolvedProduct
      |
      v
  Rego / OPA
      |
 allow / deny / warn
```

Examples:

```text
forbid standalone provider in production Kubernetes

require mTLS in regulated products

forbid public ingress without approved auth

forbid static endpoints in production
```

The distinction:

```text
resolver:
    technically valid

policy:
    organization allows or rejects it
```

---

# 73. Why Not Rego as the Main DSL

Rego excels at evaluating policy over structured data.

It is not the ideal language for:

```text
component composition
provider construction
product authoring
dependency resolution
```

Therefore Rego should remain optional and downstream of the resolver.

---

# 74. Why Not KCL/CUE as the Primary Language

KCL and CUE offer strong configuration and constraint models.

They are valid alternatives.

The current preferred direction is still Starlark because:

```text
resolution semantics remain in Rust anyway
Rust embedding is strong
build/composition precedent is mature
domain API can be tightly controlled
no separate configuration ecosystem becomes architectural authority
```

GDL remains a thin frontend over typed Rust IR.

---

# 75. Migration From Existing Metadata

Current repository metadata may exist in:

```text
gear.toml
Rust macros
#[gear(deps = ...)]
#[toolkit::consumes]
#[toolkit::provides]
Cargo features
handwritten registration code
```

The long-term goal is not to preserve all of those as equal metadata authorities.

The migration target is:

```text
gear.gdl
```

for product metadata.

---

# 76. Existing Rust Metadata Is Still Valuable for Migration

Earlier work explored parsing Rust source with `syn`.

That idea remains useful, but its role changes.

Instead of becoming the permanent catalogue implementation, it can power:

```text
cargo gears migrate-gdl
```

Example:

```text
scan Rust source
scan existing macros
scan current gear.toml
infer existing hard dependencies
generate draft gear.gdl
```

The generated GDL is then reviewed and becomes authoritative.

This reuses repository knowledge without locking the future architecture to source-code inference.

---

# 77. Compatibility During Migration

A transitional system may classify components as:

```text
Native GDL
Legacy inspected
Unknown legacy
```

But these confidence levels should not become permanent product semantics.

The end state is:

```text
Gear participating in Gearbox Builder
    =>
gear.gdl exists
```

---

# 78. Existing `deps` Relationships Are Important Migration Data

Earlier repository analysis found extensive use of:

```rust
#[gear(deps = [...])]
```

These encode important co-location relationships.

They should not simply be discarded.

Migration tooling should translate or validate them against the new GDL hard-dependency model.

---

# 79. Existing `consumes` / `provides` Contracts Are Also Valuable

The repository already has contract macros and working examples.

Those give the migration tooling and implementation prototypes real examples for:

```text
contract identity
contract version
provides
consumes
transport projections
local/remote runtime wiring
```

The new GDL model should preserve the semantics already established in those ADRs and runtime mechanisms.

---

# 80. Do Not Force Mass Migration Before Proving the Model

The system should be proven on a small, representative vertical slice first.

A good initial slice could include:

```text
mini-chat
types-registry
authn/authz/tenant resolver
a simple OoP example
cluster provider
a custom generated Gear
```

Then expand.

The objective is to validate the architecture before rewriting every Gear descriptor.

---

# 81. Canonical Acceptance Test

The most important end-to-end test is:

```text
One custom Gear
+
2-3 platform Gears
+
one product definition
+
three deployment profiles
+
zero changes to Gear business source when switching profile
```

---

# 82. Acceptance Test: Embedded

Verify:

```text
product resolves
one process where appropriate
local bindings resolve correctly
build succeeds
runtime starts
diagnostics/explanation graph are populated
```

---

# 83. Acceptance Test: Host + Workers

Verify:

```text
multiple generated process crates
DirectoryService / endpoint resolution works
remote bindings become WireOutcome::Remote
critical remote dependencies affect readiness
same Gear business code
```

---

# 84. Acceptance Test: Kubernetes

Verify:

```text
multiple images/pods
Services generated
remote binding works
external PostgreSQL supported
existingSecret supported
no secrets embedded in values
helm template succeeds
kind deployment succeeds
same Gear business code
```

Exact runtime gaps must be checked against the current repository during detailed design.

---

# 85. Regression Against Known-Good Examples

Generated artifacts should be compared with known working repository examples.

Examples from earlier repository review included:

```text
mini-chat Helm deployment
OoP calculator example
contract examples with provides/consumes
```

The detailed design should identify the current equivalents and use them as golden references.

---

# 86. Key Assumptions Must Be Tested Early

Architecture diagrams are cheap.

The following assumptions should be validated with spikes before large implementation investment.

---

# 87. Spike A1: Real Gear in GDL

Take one real Gear.

Verify that one `gear.gdl` can represent:

```text
identity
metadata
package
contracts
hard dependencies
runtime/deployment requirements
```

without requiring a second product metadata source.

---

# 88. Spike A2: Embedded Reproduction

From:

```text
gear.gdl
product.gdl
```

generate a product that behaves equivalently to a known current Embedded deployment.

---

# 89. Spike A3: Host + Workers

Use the same Gear source and product intent with:

```text
deployment = host-workers
```

and prove generated process composition works.

---

# 90. Spike A4: Kubernetes Separation

Take two Gears connected by a remote-capable contract.

Place them in separate pods.

Verify:

```text
remote endpoint resolution
remote proxy registration
readiness semantics
```

---

# 91. Spike A5: Git Source

Verify end-to-end:

```text
git source
    ->
fetch
    ->
read gear.gdl
    ->
resolve
    ->
generate build
    ->
compile
```

This validates the external-integrator story before a registry exists.

---

# 92. Spike A6: Cluster Requirements

Express a real existing cluster requirement in GDL.

Verify that the resolver can validate/select an implementation without duplicating runtime logic unnecessarily.

---

# 93. Spike A7: Process Crate Generation

Generate a standalone Cargo crate for a resolved process outside the monorepo.

Prove it builds successfully from pinned sources.

---

# 94. Spike A8: Reproducible Lock

Run resolution twice against the same inputs.

Verify:

```text
identical product.lock
```

Then change one intent value and verify the lock diff is semantic and minimal.

---

# 95. Spike A9: Explanation Provenance

For every automatic choice in the spike product, verify:

```text
cargo gears explain <decision>
```

can produce a chain back to:

```text
user intent
Gear requirement
provider capability
deployment rule
```

---

# 96. Spike A10: Profile Switch Does Not Touch Gear Source

Switch:

```text
embedded
    ->
host-workers
    ->
kubernetes
```

and verify:

```text
Gear src/ remains byte-for-byte unchanged
```

This tests the central product promise.

---

# 97. Suggested CLI Direction

The engine should be usable before GUI/TUI exist.

Potential commands:

```text
cargo gears inspect
cargo gears validate
cargo gears resolve
cargo gears explain
cargo gears build
cargo gears generate
cargo gears deploy
cargo gears migrate-gdl
```

Exact UX should follow the existing `cargo gears` tool.

---

# 98. Example: Resolve Product

```bash
cargo gears resolve product.gdl
```

Possible result:

```text
Product: cyber-protect
Deployment: kubernetes

Processes:
  event-broker-ingest x3
  event-broker-delivery x2
  authn-resolver x2

Bindings:
  EventBroker -> TenantResolverApiV1 : remote
  EventBroker -> AuthnApiV1          : remote

Cluster:
  cache             : PostgreSQL
  leader-election   : Kubernetes Lease
  lock              : PostgreSQL

Status:
  VALID
```

---

# 99. Example: Explain

```bash
cargo gears explain cluster:event-broker:leader-election
```

Output:

```text
Resolved provider:
    kubernetes-lease

Required:
    LeaderElection.Linearizable

Selected:
    automatic

Why this provider:
    deployment profile is Kubernetes
    Kubernetes Lease satisfies the requirement
    no additional infrastructure is required

Alternatives:
    ...
```

---

# 100. Example: Invalid Topology

```text
ERROR GBX-2041

event-broker.ingest requires PerInstanceAddressable.

Current deployment:
    embedded

Reason:
    ingest role is configured as sharded with 3 replicas.

Supported fixes:
    switch to host-workers
    switch to kubernetes
    disable sharding
```

Diagnostics should be actionable and explain structural causes.

---

# 101. Workspace / Crate Decomposition

Illustrative only:

```text
toolkit/
    product-model/
    product-catalog/
    product-resolver/
    product-explain/
    product-gdl/
    product-generator/
    product-mcp/

tools/
    cargo-gears/
    gears-studio/
    gears-config-tui/
```

The repository-aware detailed design should reuse existing crate boundaries where possible.

---

# 102. Suggested Implementation Phases

## Phase 1 — Typed model

Define:

```text
Catalogue
GearDescriptor
ContractDescriptor
Requirement
Capability
Provider
ProductIntent
ResolvedProduct
Diagnostic
Explanation
```

No GUI or MCP required.

---

# 103. Phase 2 — GDL

Implement:

```text
gear.gdl
product.gdl
```

evaluation into Rust IR.

Prototype on real Gears.

---

# 104. Phase 3 — Resolver

Support:

```text
enable/disable
hard dependencies
contract graph
deployment profile
placement
local/remote derivation
basic capability/provider matching
selected vs resolved
diagnostics
explanations
```

Write `product.lock`.

---

# 105. Phase 4 — CLI and Build Generation

Generate:

```text
resolved process crates
Cargo manifests
registered gears
binaries
Dockerfiles
```

Prove Embedded and Host+Workers first.

---

# 106. Phase 5 — Kubernetes / Helm

Generate:

```text
images
Services
workloads
umbrella chart
values schema
generated values
```

Validate with:

```text
helm template
kubeconform
kind
```

---

# 107. Phase 6 — Migration Tooling

Add:

```text
cargo gears migrate-gdl
```

to consume existing:

```text
gear.toml
Rust macros
deps
contract annotations
```

and produce draft GDL.

---

# 108. Phase 7 — GUI/TUI

Tauri and ratatui consume the same core engine.

No UI-specific semantics.

---

# 109. Phase 8 — MCP

Expose the typed engine to external AI agents.

Use proposal/diff/apply workflows.

---

# 110. Phase 9 — Policy

Optionally add Rego/OPA for organization rules once core validity semantics are stable.

---

# 111. Explicit Non-Goals for V1

Do not require in V1:

```text
custom parser/language
SAT/SMT
complex optimization/scoring
embedded AI chat
full organizational policy engine
every current Gear migrated
private package registry
all possible cluster providers
all role/shard runtime functionality
every deployment renderer
Terraform-specific output
Ansible-specific output
Argo ApplicationSet generation
```

Build the core model first.

---

# 112. Risks

## 112.1 GDL duplicates runtime facts

If GDL merely repeats implementation details already encoded elsewhere, drift may occur.

Mitigation:

```text
generate glue from GDL
validate referenced Rust types/contracts
remove duplicate annotations over time
```

---

# 113. Risk: Runtime Semantics Are Less Generic Than the Vision

Some desired placement/provider choices may not yet be supported by the current runtime.

Mitigation:

```text
ground every resolver rule in actual runtime capability
model unsupported states explicitly
use spikes before promising topology support
```

---

# 114. Risk: Too Much Solver Too Soon

With few providers, an elaborate optimization engine may create complexity without value.

Mitigation:

```text
start deterministic
validate constraints
add preference ranking only where multiple real choices exist
```

---

# 115. Risk: `gear.gdl` Becomes a General Programming Language

Starlark can express substantial logic.

That is useful but dangerous.

Mitigation:

```text
small domain API
typed host objects
discourage arbitrary resolver logic
keep resolution exclusively in Rust
lint unsupported patterns if necessary
```

---

# 116. Risk: Migration Becomes the Project

The current repository contains legacy metadata patterns.

Trying to convert everything before proving the system could stall the project.

Mitigation:

```text
vertical slice first
migration tool second
incremental adoption
```

---

# 117. Risk: Build and Product Versioning Are Confused

Cargo package resolution and product resolution are related but not identical.

Mitigation:

```text
Cargo owns Rust package/build semantics
Gearbox Builder owns product composition
product.lock pins exact product resolution
```

---

# 118. Open Design Questions

The detailed repository-aware design should answer:

1. What exact data belongs in `gear.gdl`?
2. Which current Rust macros can be generated from GDL?
3. Which must remain because they are compile-time language semantics?
4. How should GDL validate Rust contract references?
5. How should GDL modules/imports work?
6. Should provider definitions live beside provider crates or in shared `providers.gdl`?
7. What is the exact Product IR?
8. How is `product.lock` serialized and versioned?
9. What is the stable ID format for Gears, contracts, providers, roles, and capabilities?
10. How should package source/version resolution interact with Cargo?
11. How are optional Cargo features represented?
12. Which current deployment profiles are genuinely runnable today?
13. What gaps remain for Kubernetes endpoint resolution?
14. What current role/shard mechanisms exist versus only ADR/design?
15. Which cluster providers actually exist today?
16. Which cluster capabilities are statically discoverable?
17. How are runtime config schemas attached to the product model?
18. What is generated versus operator-owned in Helm?
19. How should process/image grouping be overridden?
20. How should proposal transactions be represented for MCP?

---

# 119. Pitch: What Changes for a Developer

Without Gearbox Builder:

```text
clone monorepo
understand Cargo features
edit registration
understand hard dependencies
manually decide co-location
create binaries
create Dockerfiles
create Helm
wire endpoints
choose cluster providers
debug runtime mismatches
```

With Gearbox Builder:

```text
describe Gear once
compose product
select deployment
resolve
inspect
generate
```

---

# 120. Pitch: What Changes for an Integrator

The long-term external integrator experience becomes:

```text
product.gdl

platform gears:
    fetched from git/registry

custom gears:
    local or private source

deployment:
    embedded | host-workers | kubernetes

output:
    reproducible build
    product.lock
    images
    Helm
```

No fork of the Gears monorepo should be required.

---

# 121. Pitch: What Changes for Platform Engineering

The platform team gains a formal place to encode:

```text
supported deployment topologies
contract relationships
provider capabilities
product requirements
role/shard semantics
automatic choices
deployment generators
policy hooks
```

instead of leaving this knowledge scattered across:

```text
README files
Cargo features
ADR knowledge
Helm
developer memory
```

---

# 122. Strategic Value

Gearbox Builder would move Gears from:

```text
a modular Rust framework
```

toward:

```text
a product construction platform
```

The difference is significant.

A framework gives developers building blocks.

A product platform knows:

```text
what the blocks are
how they fit
which combinations are valid
how they are deployed
how to explain the result
```

---

# 123. Why This Matters More in an AI-Driven Development World

Developers will increasingly ask agents:

```text
“Make this product HA.”
“Move this to Kubernetes.”
“Use existing PostgreSQL.”
“Separate Event Broker.”
“Why did this require Redis?”
```

Without a typed product model, an LLM can only manipulate files heuristically.

With Gearbox Builder:

```text
natural language
    ->
MCP typed operations
    ->
deterministic resolver
    ->
validated proposal
```

This gives AI agents a safe, semantic control plane instead of a text-editing guessing game.

---

# 124. Strategic AI Principle

> **Do not put AI inside the source of truth.  
> Put a semantic API in front of the source of truth.**

That is why MCP is a better AI integration than an embedded chat.

---

# 125. Final Architecture Statement

The proposed direction can be summarized as:

> **Gearbox Builder is the product composition and resolution layer for Gears.**
>
> **`gear.gdl` is the single source of truth for Gear product metadata and composition semantics.**
>
> **`product.gdl` expresses product intent.**
>
> **GDL uses Starlark as its deterministic authoring runtime.**
>
> **Typed Rust IR is the canonical internal model.**
>
> **The Rust resolver is the sole authority for dependency, contract, capability, provider, placement, and topology decisions.**
>
> **`product.lock` records the exact resolved product and becomes the input to all generators.**
>
> **CLI, TUI, GUI, and MCP are clients of the same core engine.**
>
> **AI agents interact through MCP and skills, while correctness remains deterministic.**
>
> **Rego/OPA may later enforce organization policy over resolved products, but does not replace GDL or the resolver.**

---

# 126. One-Slide Version

```text
GEARBOX BUILDER

“Cargo for Gears products”

gear.gdl              product.gdl
Gear metadata         Product intent
      \                  /
       \                /
        +--------------+
        | Rust Resolver|
        +------+-------+
               |
          product.lock
               |
     +---------+----------+
     |         |          |
   Build      Helm       Tools
                         CLI/TUI/GUI
                             |
                            MCP
                             |
                         AI Agents
```

**Configure intent. Derive a valid product. Explain every decision.**

---

# 127. Repository Grounding for the Next Design Phase

This vision intentionally combines:

- the current Gears deployment-profile ADR direction;
- contract binding and eventual-readiness semantics;
- current hard-dependency and contract concepts;
- role/shard and instance-addressability design;
- cluster capability/provider design;
- existing build/run/generator work;
- known-good mini-chat and OoP examples identified during earlier repository review;
- the earlier `product.lock`, generated-process, Helm, and external-integrator ideas;
- the newer decision to replace fragmented metadata with one authoritative `gear.gdl`;
- the newer decision to use Starlark as the GDL runtime;
- the newer decision to expose MCP rather than embed an LLM chat.

The next step is a repository-grounded DESIGN that verifies each assumption against the current `gears-rust` implementation before fixing concrete schemas, crate APIs, migration rules, and generator behavior.
