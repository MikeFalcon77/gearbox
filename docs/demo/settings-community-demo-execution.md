# Settings Community Demo — execution notes

The approved scope is [settings-community-demo-plan.md](settings-community-demo-plan.md).
Keep that plan unchanged. This file records implementation and verification; a
phase is complete only when its exit checks have actually passed.

## Source baseline

- Gearbox: `codex/settings-community-demo`, based on `feature/gdl-extensible`
  at `6d60603f8db36ef30ee50e1ff7008f3ee24a2501`.
- gears-rust: `codex/settings-community-demo`, based on `feature/gearbox`
  at `b90bea456f0894dc703cf7e9b546397e8fcda215`.
- The pinned `guidelines/DNA` submodule in gears-rust was initialized at
  `8ec85f2bb3012ccafbadcc0fb18f1876f50f0127`.
- No reset, clean, push, or changes to the feature branches.

## Prepared Firebase handoff

Setup and both real account verifications were completed before implementation.
The agent reads the ignored local directory `.gearbox/firebase-preflight/`:

- `authn-demo-inputs.json`: project, issuer/audience, UID-to-tenant mappings.
- `firebase-web-config.json`: browser SDK configuration.
- `state.json`: readiness state (`firebase-ready`).
- `signins.json`: verification evidence.

Do not repeat project creation or require a Firebase CLI login for normal build
and deployment. Do not copy credentials, real account mappings, or private
photographs into tracked files.

## Phase 0 — complete

Implemented:

- Shared integration-test corpus discovery, with an explicit root and a required
  corpus mode that fails instead of silently skipping.
- Portable generator-test output paths on the source drive.
- Dockerfile-specific ignore files and an allowlist for declared source roots
  and this generated output. Source configuration, build caches, `.git`, `.env`
  files, and unrelated projects are excluded.
- Static Kubernetes contract endpoints are pinned even when the profile declares
  Postgres. Previously that profile condition silently omitted consumer wiring.
- Correct TOML escaping for the Windows path in the registry patch unit test.
- Reuse of the immutable real-corpus scan within the generator test binary.
- Source-root open errors fail the corpus suites. The projection smoke test
  permits only the expected local-fork source-URL warning (`GBX0121`); the CLI
  continues to report that warning. Other catalogue diagnostics still fail it.
- `protobuf-compiler` and `libprotobuf-dev` in the Docker build stage, required
  by Directory SDK (including `google/protobuf/empty.proto`).
  BuildKit Cargo caches preserve dependencies and compiled artifacts between
  builds; the binary is copied out of the cache into the image layer.
- The runtime image creates and owns the configured home directory before
  switching to the non-root user. A real container config check caught the
  otherwise unwritable `/var/lib/gearbox`.

Verification:

- CLI build: `cargo build --offline --locked -p gearbox-cli`.
- Remote worker wiring regression passes against the real checkout.
- A deliberately missing required corpus fails the test, as intended.
- Real Docker context probe confirms source and generated config inclusion,
  and exclusion of Firebase handoff, unrelated projects, source `config/`,
  `.git` and `target/`.
- `cargo clippy --offline --locked -p gearbox-engine --all-targets -- -D warnings`.
- Engine coverage: 414 tests across 32 unit/integration binaries. The broad run
  exposed two assumptions in `validate` (fork remote warning and Windows path
  separators). After correcting them, that entire binary passes 7/7. The other
  31 binaries passed the broad run. Generator tests were rerun after the Docker
  changes and pass 53/53; database tests pass 9/9. The original full-run log
  retains the two superseded failures; `validate-final.log` records their fix.
- Formatting and diff whitespace checks pass; doctests complete (none defined).
- Real generated Gateway Docker build passes, including Directory protobuf
  compilation. Final image ID:
  `sha256:d6c7e7138a3a63265d5a2ed50972cbc183c8d100cc6c2a2b1092c23983e52ca3`.
- The final container's `--list-registered-gears` matches `gearbox lock gears
  --order name --with-deps` exactly: six gears and their dependencies.
- Loading and checking the generated configuration succeeds in the final
  container as the non-root application user. This does not claim database
  connectivity or full product startup; those are phase-1 checks.

### Local verification environment

The existing Windows Docker context points to an unavailable WSL TCP endpoint.
The user's original WSL Docker service was already failing because of a bridge
metadata conflict. Its network database and volumes were preserved.

A separate WSL Docker daemon is running as `gearbox-demo-docker.service` with:

- socket: `unix:///run/gearbox-demo/docker.sock`;
- data root: `/var/lib/gearbox-demo/docker`;
- config: `/var/lib/gearbox-demo/daemon.json`;
- bridge: `gbxdemo0`, `172.30.0.1/24`.

Use `wsl -d Ubuntu -- env DOCKER_HOST=unix:///run/gearbox-demo/docker.sock ...`
for this demo environment. The user's Windows Docker context is unchanged.
Do not repair the original daemon by deleting network state or volumes.

Ignored phase-0 evidence is under `.gearbox/phase0-smoke/`: source product,
generated tree, generator diagnostics, engine test log, Clippy log, negative
corpus test log, and Docker build logs (`docker-build-final.log` is final).
The generated tree uses relative Cargo
paths and is built from Linux through the WSL mount of the same checkouts.

Required test environment:

```powershell
$env:GEARBOX_CORPUS_ROOT = 'C:\projects\gears-rust-mikefalcon77'
$env:GEARBOX_CORPUS_REQUIRED = '1'
cargo test --offline --locked -p gearbox-engine
```

## Remaining phases

2. Existing Firebase integration, technical authentication, policy and bootstrap.
3. Remote Settings contract, transactional outbox to EB, Cluster and OAGW.
4. UI SDK, shell, GDL declarations and generated frontend deployment.
5. Four UI modules, professional design, private photos and the ice cream scene.
6. Prepared bundle, image warming and one-click Deploy in Gearbox.
7. End-to-end checks, persistence and recovery, runbook and presentation rehearsal.

Phases 0 and 1 are complete. Final Mac rehearsal needs evidence
from the actual presentation machine; Windows or WSL checks cannot substitute.

## Phase 1 — complete

Backend commit: `fc5a832d3` (`gears-rust`, same demo branch).

Implemented and verified:

- `sqlite_databases = {"event-broker": "metadata.sqlite3"}` on deployment
  profiles, with typed IR/lock/diff/TypeScript and isolated runtime configuration.
  Paths are relative to `home_dir/<gear-id>/`; invalid paths and multiple
  writers are refused. Postgres-only products keep their existing lock shape.
- SQLite workloads default to PVC + Recreate; Helm validation refuses
  `emptyDir`, an empty claim, rolling updates or multiple replicas.
- Pins on a REST host name the host application, rather than turning it into a
  worker. Selected plugins now follow every process containing their host.
- The prepared product is `products/settings-community-demo/product.gdl`.
  It currently uses technical-only strict static AuthN. Firebase integration
  remains phase 2; no accept-all deployment profile was added.
- Directory DNS is generated for the worker. The platform provider declared by
  API Gateway is propagated to grpc-hub and `oop_http`. Shared secrets are
  supplied through AppConfig's `APP__` environment overrides from Kubernetes
  Secrets. Empty values in tracked configuration deliberately fail without the
  prepared Secret; a literal `${VAR}` is not used as a platform credential.
- Necessary structured config fields were exposed in source GDL. EB now
  declares its actual cache/leader-election/lock requirements, so the Postgres
  Cluster binding reaches generated runtime configuration.
- Static AuthN credentials support the existing Toolkit ExpandVars mechanism;
  missing variables fail initialization. Its 19 unit tests pass, including
  expansion, backward compatibility and redacted debug output.
- Private generated inputs are prepared by `scripts/prepare-inputs.cjs` in the
  product directory. They are under `.gearbox/settings-community-demo/private/`;
  existing credentials are preserved and are not printed.

Verification evidence under ignored `.gearbox/`:

- `phase1-database-tests.log`: 15/15 database tests.
- `phase1-model-tests-final.log`: GDL, IR and canonical lock suites pass.
- `phase1-community-tests-fixed.log`: 4/4 checks against the actual demo product.
- `phase1-bindings.log`: deterministic TypeScript exports pass.
- `phase1-generated-types-check.log`: the generated wire types compile with
  TypeScript 5.4.5. Full Studio build remains to be checked after IDE dependency
  installation; this check does not claim that build passed.
- `phase1-chart-check.log`: real Helm 3.17.3 rendering and negative values checks.

### Isolated runtime

- Minikube profile/context: `gearbox-demo`, Kubernetes v1.32.0, containerd 1.7.24.
- Private kubeconfig: `/home/mike/.config/gearbox-demo/kubeconfig` in WSL.
  Always pass `--context=gearbox-demo`; `--keep-context` preserved the user's
  current context when starting this profile.
- Docker network: `gearbox-demo`, subnet `192.168.58.0/24`.
- External Postgres: owned container `gearbox-demo-postgres`, volume
  `gearbox-demo-postgres-data`, on that private Docker bridge. Operator port
  55432 is bound only to `127.0.0.1`.
- Kubernetes reaches it through the ClusterIP Service `external-postgres` and
  an EndpointSlice generated from the actual Docker container address. This
  provisions no PostgreSQL server workload in Kubernetes. The same scheme
  avoids host-wide port publishing on WSL and Docker Desktop on Mac.
- An initial command publishing on `0.0.0.0` was rejected by automatic approval
  review. It did not execute. The implementation was changed to private bridge
  connectivity plus loopback operator access, and the narrower action succeeded.
- Actual PVC `gearbox-demo-gateway-data` is Bound; its PV
  `pvc-e0edec80-7859-47e0-9089-ed8155dfa107` has reclaim policy Retain.
- A read-only SQL client Job in Kubernetes successfully connected to all four
  external databases: `credstore`, `settings_service`, `types_registry` and
  `gearbox_demo_cluster`.

The full Gateway adds OAGW's native compression dependency, which required
`cmake` in the generated build stage. Actual startup exposed and fixed:

- Kubernetes `args` replaced the image CMD without an ENTRYPOINT. Generated
  Deployments now explicitly name their executable from the resolved app.
- The Postgres lock provider needs its own options; the product declares them
  explicitly alongside cache options.
- OOP bootstrap retained only the anchor's database configuration, discarding
  Credstore and Types Registry databases. It now merges every local gear's DB.
  All 38 bootstrap OOP tests pass, including real SQLite connections for three
  co-located gears and a dependency whose anchor has no database. Toolkit
  Clippy with bootstrap and all targets passes.
- Plugin attachment previously imposed a false dependency on the host. Process
  membership now includes plugins first; actual dependency edges determine
  initialization order. All 19 partition tests pass, including the existing
  plugin-to-resolver dependency-order check.

The Gateway is Ready in Kubernetes with strict technical authentication.
Authenticated Discovery, Types V1 and EB list requests return 200. Both actual
SQLite files and event-log WAL/SHM are under the retained mount. Postgres
contains the actual Cluster cache and lock tables in `demo_cluster`.

The first Helm install timed out while the startup defects were investigated;
its failure is retained in `phase1-deploy.log`. A corrected upgrade succeeded.
The final worker, proxy, replay and lifecycle checks below pass. Failed
exploratory runs are retained rather than presented as successful evidence.

Further real HTTP checks exposed these integration gaps:

- Directory authorizes a shared identity only for its own gear name by default.
  The demo's single remote registrar is now named `settings-service`; no
  cross-gear trusted registrar has been enabled.
- Settings had no exposed proxy operations. Its authenticated declarations list
  is now exposed, and a real Gateway-to-worker call returns 200 while an
  anonymous request returns 401.
- Worker requests re-validate the forwarded bearer; platform authentication
  alone does not provide a tenant SecurityContext. GDL `application(...,
  include = ["authn-resolver"])` now explicitly co-locates process-local services
  with their dependencies and selected plugins. Included gears must already be
  in the product closure. The actual worker now links 10 gears, including its
  strict AuthN stack; Gateway still links 15. Both inventories match the lock.
- tr-authz emitted an unsupported owner predicate for unscoped capability
  checks. It now preserves the tenant decision but omits row constraints only
  when the caller declares no row properties, requires no constraints, and
  supplies no group selector. Row and group checks retain their constraints.
  All 29 plugin tests and Settings route-authentication checks pass.
- REST publish currently acknowledges the durable ingest outbox with 202.
  Despite outdated route descriptions, synchronous persistence is not
  implemented. Runtime checks use the real async operation, then verify actual
  persistence through replay.
- The first multi-producer replay found a genuine relay bug: the SQLite backend
  deduplicated different producers' first sequence as one partition chain. The
  ingest relay now stamps the durable outbox sequence at the backend boundary;
  client protocol counters remain validated in ingest metadata. New regression
  tests cover independent producers and replay of stateless outbox messages.
  All five relay tests and the rebuilt Gateway's real replay checks pass.
  Already discarded development-test events are not claimed to be recovered.

Phase 2 must also verify the concrete target-tenant check when an EB request
supplies `owner_tenant_id` without a resource ID. Do not rely on a returned row
scope as proof that a specific target tenant was authorized; the demo policy
and negative integration tests must cover that boundary.

Additional evidence: `phase1-include-model-tests.log`,
`phase1-include-resolution-tests.log`, `phase1-include-generation-tests.log`,
`phase1-include-bindings.log`, `phase1-include-grammar.log`,
`phase1-include-typescript.log`, `phase1-include-clippy.log`,
`phase1-service-clippy.log`, `phase1-inventory-proof.log` and
`phase1-postgres-connections.log`. Failed exploratory runs remain available.

### Final phase-1 exit checks

- Both generated images build and their actual inventories match the lock:
  Gateway 15 gears, worker 10 gears.
- Strict authentication, Directory registration, actual Gateway-to-worker
  routing, producer/group creation, durable producer cursors and replay of the
  original event over SSE pass (`phase1-runtime-relay-fixed.log`). The replay
  checks the event ID, tenant, topic, payload and assigned sequence.
- Pod recreation uses a different pod UID
  (`phase1-pod-recreation-proof.json`). The original event and metadata replay
  successfully afterwards (`phase1-runtime-after-pod-recreation-final.log`).
- A repeated full Deploy succeeds without resetting state
  (`phase1-repeated-deploy.log`, `phase1-runtime-after-repeated-deploy.log`).
- The dedicated minikube profile was stopped and started. Initial exploration
  caught cold DNS racing application migrations; both backends now have a
  non-root, read-only SQL-client init container that waits for the external
  database. The final stop/start recovers both actual HTTP readiness endpoints;
  each backend has exactly the one normal container restart from the node stop.
  The original event, group and producer cursor still replay
  (`phase1-minikube-stop-start-final.log`, `phase1-runtime-persistence-final.log`).
- The same claim remains Bound to
  `pvc-e0edec80-7859-47e0-9089-ed8155dfa107` with Retain; no PVC, namespace or
  minikube profile was deleted (`phase1-pvc-final.log`).
- SQLite metadata/event log and WAL/SHM are on that mount. Settings, Credstore,
  Types and Cluster actually connect to the external Docker Postgres. Actual
  Cluster cache and lock tables exist and event publication creates cache
  markers; notification/polling behavior is the phase-3 check.
- Engine suites pass through the broad run and affected-suite reruns. The
  include extension's model, partition/structural, generation, binding and lock
  checks pass; generated TypeScript and grammar exports are deterministic and
  wire types compile. Workspace Clippy and touched backend packages' Clippy
  pass. Generated ts-rs whitespace follows the existing exporter; other diff
  whitespace checks pass.

Final local images:

- Gateway: `sha256:737c8ab493a3cab60a396997c00aa0065dd27ea021c14d2dfc9cdb264b0f4348`.
- Worker: `sha256:eba7005a0224e449a105707c9b011b27629723f276000d87c49f60a260f93dd5`.

Firebase integration/policy, transactional Settings events, UI, prepared Deploy
integration and final rehearsal remain phases 2–7. Phase 1's technical smoke
test restores V1 declarations through the authenticated API; phase 2 supplies
the approved SDK-owned startup bootstrap. Freeze a common generated Cargo.lock
and use locked builds when preparing the final warmed bundle in phase 6.

## Phase 2 — complete

The existing Firebase handoff is reused without cloud changes. New standalone
Firebase authentication and explicit demo authentication/authorization plugins
are configured by `products/settings-community-demo/auth.gdl`. Real account
mappings are expanded from the ignored private handoff into Kubernetes Secrets;
tracked templates contain no personal identities. Credential schema migration
preserves the phase-1 database, internal-auth and bootstrap credentials and adds
a distinct, restricted worker token.

Verified so far:

- Firebase verifier: 18 tests, including real RSA/JWK signature verification,
  issuer/audience/timing, unknown keys, outages and ignored forged tenant claims.
- Explicit Firebase/static dispatcher: 3 tests; JWT failure never falls back.
- Demo action policy: 6 translation tests; concrete owner-tenant checks preserve
  the hierarchy plugin's decision. These are unit tests, not runtime proof.
- New auth crates pass Clippy with warnings denied.
- A real product test caught worker-only `include` contributions also seeding the
  default host. Resolver placement now preserves intentional shared dependencies
  without pulling the Settings bootstrap and Settings itself into Gateway.
  Community generation (5) and partition (19) tests pass; engine Clippy passes.
- SDK bootstrap runs in the lifecycle after migrations, before worker readiness.
  It reconciles public, non-step-up demo defaults without writing tenant values.
  Existing declarations now restore their process-local derived Types schemas
  on reconciliation. Contribution tests: 32 passed, including restart restoration.

Runtime evidence now available:

- Actual linked inventories equal the generated lock: Gateway 19, worker 15.
- SDK bootstrap successfully creates both declarations in the real worker after
  migrations, before its routes become ready.
- Catch-all scope enforcement initially blocked Kubernetes probes. The existing
  Gateway contract documents `/healthz`, `/readyz` and `/health` as public. Exact
  GET probes now remain public; POST and similarly named application routes stay
  protected. All 22 scope-enforcement tests and Gateway Clippy pass.
- The interrupted Helm upgrade was recovered with Helm rollback followed by a
  corrected deployment. Release 12 is deployed and both backend pods are Ready.
  The same retained PVC is still Bound; no data resources were deleted.
- `phase2-runtime-proof.log`: authenticated Directory registration and actual
  Gateway-to-worker proxy pass; anonymous access fails. Metadata/cursors and the
  original phase-1 event still replay through real SSE after the failed rollout
  and recovery.
- `phase2-technical-proof.log`: unknown opaque/malformed JWT credentials fail;
  worker access to Settings/schema writes fails; publications for root, unknown
  tenant and foreign event types fail; demo events for both allowed tenants pass.
- Changed-file scan finds no runtime credentials or real account mappings in
  either repository (`phase2-private-content-scan.log`).
- `phase2-bootstrap-restart-proof.log`: a non-default demo override is committed
  through the authenticated API, the real worker is restarted, and the value
  remains unchanged after its SDK bootstrap. Another validated write succeeds
  with the freshly restored derived type. The temporary QA override is then
  reverted through the scoped API and the original schema-default state is
  verified. No business rows are edited with SQL.

Both real Google accounts pass the deployed backend checks
(`private/identity-check-dasha.json`, `private/identity-check-ilya.json`, verified
2026-10-18 07:51 UTC). Each token is assigned its expected tenant; own-tenant
write/subscription and read-only diagnostics succeed. Sibling Settings read,
write and EB subscription fail; schema writes and producer management fail.
The user completed ordinary sign-in after browser automation could not control
the OAuth popup. No cloud setup was repeated. The harness keeps tokens in request
memory and saves only check results under ignored private storage.

Phase 2 exit conditions are satisfied. Transactional Settings events, remote
Settings contracts, the final UI and prepared Deploy remain phases 3–7.

The failed rollout exposed a final-preparation requirement: immutable image tags
derived from image content must accompany the phase-6 fingerprint. Reusing one
mutable tag allows a Helm rollback to pair an older config with a newer binary.
Record and retain prior prepared image identities for reproducible rollback.

## Phase 3 — complete

The new authorized `SettingsReadApi v1` and its generated REST projection reuse
the established effective-value DTOs. The trusted embedded reader remains
compatible. Remote reads enforce PDP, the caller's tenant subtree, administrative
visibility and public classification; secret/PII values are hidden. Bulk reads
have a 500-key bound and independent canonical per-key failures, with request
authorization even for an empty list.

`family-labs-api` consumes this contract from Gateway using the generated REST
client and the worker's Kubernetes Service DNS. It also registers per-laboratory
OAGW echo upstream/route declarations through the Types SDK before OAGW's
post-init materialization. This keeps the normal proxy owner-tenant checks and
the configured exact-host SSRF allowlist. Outbound headers exclude credentials.

The optional Settings community event integration uses the existing
`DbProducer`, `ProducerOutbox`, managed producer registration and `RestBroker`.
Schema preparation and authenticated producer registration happen before
readiness. Mutation, audit and enqueue share the same transaction. Wake handles
are fired after commit. Notification payloads carry coordinates and request IDs,
without setting values. The outbox and producer state live in the Settings
Postgres database; EB metadata and event log remain on the retained SQLite PVC.

The EB delivery notifier now waits for the remaining shared deadline when a
prefix watch fails or closes; warnings are throttled. A later runtime audit
confirmed that this retained notifier port is not called by the current stream
implementation. Active delivery uses the partition loader's bounded tail polling
and local readiness notifications. PostgreSQL prefix watch is unsupported and is
not presented as the mechanism behind the live browser updates.

Verified locally so far:

- Settings: all 772 library tests pass, including three remote authorization
  tests and a real SQLite transaction rollback when producer enqueue fails.
- Existing Settings SDK: 85 tests pass; three prior documentation examples remain
  ignored as before.
- EB storage facade: all 12 tests pass, including failed/closed-watch polling
  deadlines and immediate wake on a real watch notification.
- All four touched crates pass library Clippy with warnings denied and formatting.
- Real-corpus product generation and five community composition tests pass. The
  new binding is remote REST from Gateway to Settings worker, with a concrete
  static Service DNS endpoint. Both backend images build successfully.
- Real Helm rendering and unsafe SQLite override rejection pass.

Runtime checks exposed and fixed three additional integration defects:

- Gearbox emitted the legacy bare-string `consumer_wiring` form. It now emits
  an object with `endpoint` and preserves existing client policy options. The
  regression uses the actual prepared product. Community (6), consumer wiring
  (3) and generation (53) tests pass.
- SDK managed-producer timestamps were Rust strings against Postgres
  `TIMESTAMPTZ` columns. They now use native UTC timestamp types. All 34 producer
  integration tests pass, including SQLite persistence and builder compile
  checks. The deployed Postgres registration has generation 1 and native
  timestamp-with-time-zone columns.
- A failed Settings lifecycle could leave the HTTP worker advertising Ready.
  Settings now contributes lifecycle readiness, retries transient broker startup
  failures with throttled logs, and cancels startup cooperatively.

Real runtime evidence:

- The generated Gateway-to-worker contract forwards the bearer and target scope.
- A Settings change produces an event through the real remote EB; the event has
  a stable ID, tenant, key, change-set ID and request correlation, and no value.
  The subsequent remote Settings reread sees the committed value; Ilya's value
  remains unchanged. The temporary value is restored through the scoped API.
- With Gateway/EB fully stopped, a write commits through the direct worker
  endpoint. After worker restart the value remains durable and worker readiness
  is 503. Restoring Gateway/EB makes the worker ready and delivers the pending
  event through real SSE (`phase3-offline-restart-proof.log`,
  `phase3-recovered-event-proof.log`).
- The original phase-1 event, metadata and producer cursor still replay from the
  same retained PVC after these restarts. No data resources were removed.
- OAGW restores both child-tenant echo upstreams and routes from SDK declarations.
- Real JOIN/SSE activity creates two live Postgres routing markers. Successful
  ingest also updates a live `evbk/notif/.../0` key in `demo_cluster.cluster_cache`
  (`phase3-postgres-cluster-proof.log`, `phase3-cluster-notification-proof.log`).
  These are actual provider writes; the current loader, rather than prefix watch,
  performs the delivery rechecks. No new invalidation mechanism is added for show.

At the backend checkpoint, the early browser vertical and real-user OAGW call
were still pending; their completed checks are recorded below.
The temporary `verify-events.cjs` and loopback-only `verify-vertical.cjs` helpers
exercise these before the modular UI is introduced.

The verified backend checkpoint is committed in gears-rust as `1a03e7aa7`.
Release 17 is deployed; the final worker image includes the native timestamp,
startup retry and readiness fixes. Browser verification is waiting for ordinary
Google sign-in at `http://localhost:4175/?lab=dasha` and
`http://localhost:4175/?lab=ilya&observe=1`. This is a temporary backend proof,
not the final product UI. Firebase cloud configuration remains unchanged.
UI SDK implementation has not started before this phase's browser exit check.

The user completed both normal Google sessions for the browser vertical.
Two independently subscribed Dasha tabs received event
`01a14e34-905d-75c7-b935-3620badaf73b`, then reread `true` through the remote
Settings contract. Ilya remained `false` with no Dasha event. Resetting through
the editor produced the same reset event in both Dasha tabs; their private
receipts have distinct tab IDs. The observer screenshot is retained locally as
`.gearbox/phase3-live-proof.png`.

The real-user OAGW check exposed an existing SSRF inconsistency: the explicit
hostname exemption passed management validation, but both DNS-result filters
still rejected the service's private IP. The fix carries the configured hostname
exemption into those filters, while ordinary hosts remain subject to IP checks.
All 689 OAGW library tests pass, including scoped exemptions and the actual DNS
discovery regression. Release 18 deploys Gateway image
`sha256:7bc299e90b2aae2891b0556c7b96446d53d7972553d4d825bef412d442a05f8d`.
Both real Google users successfully invoked the private echo through OAGW.
Dasha's returned request ID was `41608c26-2b71-4014-a61a-f73177a3c34a` and
Ilya's was `c9eb4402-c99d-48fc-a40e-6350af82e748`; the browser helper checks
each against its outgoing header. The screenshot is retained locally as
`.gearbox/phase3-oagw-user-proof.png`. OAGW Clippy passes with warnings denied.
All phase-3 technical exit checks are now satisfied. The corresponding
gears-rust fix is committed as `0a1639865`.

The user authorized Claude review of completed phases. Claude Code is installed
in WSL at `/home/mike/.local/bin/claude`. The phase-3 packet contains only the
approved plan, execution notes and tracked commit diffs; no private handoff,
credentials or photos. The first read-only review attempt returned an expired
OAuth session, so no Claude findings or approval are claimed. The user has been
asked to refresh that CLI session while implementation continues.

Claude review subsequently succeeded after the user refreshed the session and
the CLI was updated from 2.1.76 to 2.1.302. The requested invocation explicitly
used `--model claude-opus-5-5 --effort high`; returned usage confirms
`claude-opus-5-5`. The local report is
`.gearbox/phase3-claude-review-opus55-high.txt`. It reviewed the supplied committed
diffs and evidence, without live checkout tools or private inputs.

Review follow-up:

- The active loader really could retry an immediate backend failure without
  sleeping. This is fixed at the shard loop, for both tail and backfill work.
  All 38 loader tests pass, including a paused-time regression that observes one
  read before the tick, one retry after it, and prompt cancellation. There is no
  per-failure warning in this path. The fix is committed as `bd26afcf4`.
- The early browser page silently discarded foreign-tenant frames. Its guard
  now fails explicitly, and receipts include the observed count and pass state.
  The prior screenshot proves same-tenant updates and Ilya's unchanged value;
  it does not by itself prove absence of foreign frames. The modular UI stream
  must apply the same guard as well. The strengthened live run is recorded below.
- Echo declarations now set immutable upstream/owner markers, and echo reflects
  them. The helper checks them as well as request correlation. The live check
  on release 20 confirms both upstream/owner pairs and request IDs.
- Hostname exemptions intentionally follow the existing documented allow-first
  policy, including resolved addresses. Changing precedence would change that
  policy. This product exempts one exact, operator-controlled Kubernetes service
  name; ordinary names still undergo IP checks. No broad demo exemption is added.
- Startup readiness intentionally waits for managed producer registration. An
  already started worker can commit during an EB outage; after a cold restart
  it remains unready until registration recovers. No claim of cold-start write
  availability during an EB outage is made.
- Set/revert use the shared commit; batch calls it at `value_writes.rs:485` and
  clone at `:849`. Pending-secret cleanup is not a public demo value mutation.
  Internal errors go through the canonical Problem conversion; the existing
  `an_unrecognized_error_leaks_nothing` test verifies redaction.
- The bootstrap credential also serves as the private operator identity for
  technical QA. Bootstrap code itself seeds declarations, not tenant overrides.
  This is broader than a dedicated bootstrap-only token and remains a bounded
  demo limitation. Real-user access checks use the separate Google sessions.
- Optional event integration currently adds shared SDK dependencies/migrations
  to every Settings build; direct REST broker URLs and the two-lab identifiers
  are product-specific. Bulk reads repeat per-key authorization. These are
  documented demo tradeoffs, not claims of a production integration framework.
- Child override changes produce events; parent-driven effective-value fan-out
  is outside this demo. Temporary QA groups need cleanup before final rehearsal.

## Phase 4 — complete

Implemented optional GDL 1.2 UI locators and explicit product composition,
typed IR and lock schema 3, backend requirement validation, generated npm
workspace/registry/runtime config/nginx/Dockerfile/Helm, and package.json
identity/export/API checks without JavaScript execution. A companion UI lock
records package content hashes and the parent lock hash. Existing products
without UI still generate their backend artifacts.

Added `@gears/ui-sdk`, `@gears/product-shell`, and the Settings UI package on the
boring-pills stack. The shell owns Firebase login, backend `/me` identity,
identity/tenant query keys, request cancellation/cache cleanup, navigation,
notifications, lazy pages, widget slots and error boundaries. The existing
public Firebase configuration is prepared with `scripts/prepare-ui.cjs`.

Release 19 has a working nginx UI in minikube. Both existing Google sessions
restored without another login, showed the correct server-selected laboratory,
and read Settings through Gateway to worker. Screenshot:
`.gearbox/phase4-product-ui-proof.png`. Actual SSE through the UI nginx proxy
also passes (`phase4-nginx-events-proof.log`, event
`01a14e4d-50cd-767b-9e6c-711cb1a61dc6`), with the temporary value restored.

Current checks include 79 engine library tests, 7 community composition tests,
53 prior generation tests, the missing-backend UI test, all GDL/IR/lock suites,
TypeScript export/determinism, UI production build and five SDK transport/cache
tests. Both engine and identity adapter pass Clippy. Final widget-slot sources
also build, and release 20 deploys Gateway
`sha256:f8b255b4e4c3c0c806b89b90240eebdf994c3c4c8a75d3dfeb3986abb56d6555`
and UI `sha256:f8bfc7390bdc2a04556afb41dc916668367219dd31249465cde8b32c94d146d9`.
The UI uses a content-derived image tag; the umbrella's strict values schema
explicitly accepts its image override. Echo rolls on its code checksum. Helm
rendering, strict lint and invalid SQLite override checks pass.

The strengthened browser run uses the same three Google sessions through UI
nginx. Both Dasha tabs received `01a14e5b-0582-760f-a1e9-f4834a0c2275` and reread
`true`. All three tabs explicitly report zero foreign-tenant frames; Ilya
remained `false` without a Dasha event. Both OAGW calls reflect the correct
per-lab upstream ID and owner tenant, with matching request IDs. Reset then
produced the same reset event in both Dasha tabs. Text and screenshot evidence:
`.gearbox/phase3-review-browser-proof.txt` and `.png`. These close the two
browser-proof gaps identified by Claude. The temporary proof page is excluded
from the next product image build.

Four full UI modules, photos and live confetti remain phase 5; the prepared
one-click Deploy path remains phase 6. The approved plan itself is unchanged.


## Phase 4 — Claude Opus 5.5 high follow-up

The requested reviewer ran as `claude-opus-5-5 --effort high` with tools disabled,
against the two committed phase-4 diff packets. Report (private ignored work
folder): `.gearbox/phase4-claude-review-opus55-high.txt`. Recommendations were
checked against source rather than treated as verified runtime failures.

Confirmed and addressed in phase 5: token refresh no longer tears down the
session (`onAuthStateChanged`, per-request credentials, one forced retry on
401); laboratory presentation and setting keys move into product runtime
configuration; UI shell/SDK paths can resolve through a named source root;
UI gear declarations use GDL 1.2; all string exports are validated and the
shell CSS export is required; package hashes use length framing; opaque assets
have `FileKind::Binary`; encoded traversal/control-character routes are rejected;
Google explicitly offers account selection; generation no longer overwrites
prepared runtime configuration; nginx uses the namespace-local Service name;
the UI pod does not mount a service-account token. Non-Kubernetes UI generation
returns before requiring a Kubernetes Gateway port. Generic HTML title uses
the product ID (the resolved header has no display-name field).

The reviewer suggested a tracked npm lock tied to prepared inputs. This remains
part of phase 6 bundle preparation, together with retaining content-derived
backend image tags for rollback. The existing corpus helper already fails when
`GEARBOX_CORPUS_REQUIRED` is set; mandatory checks continue to set it explicitly.
The optional SDK source format deliberately accepts stable numeric major >= 1;
pre-1.0 SDK compatibility ranges are rejected rather than guessed.

## Phase 5 — complete

All four module packages now build from GDL: Settings (bool/string/number forms,
ETag conflict UI, history, OAGW), Event Broker live inspector, Discovery and
Types Registry V1 with explicit Gateway/Settings sources. The demo-owned
registry adapter forwards caller credentials only to fixed endpoints, limits
responses, disables redirects and filters out other/unscoped tenant instances.
Its source-allowlist and sibling-instance filtering tests pass.

SDK streaming tests cover fragmented UTF-8/SSE, actual control-frame shapes,
checkpoint scope, EOF/JOIN/SEEK recovery, event-ID deduplication, failed effective
read without advancing a checkpoint, foreign-tenant fail-closed handling and
bounded cleanup. The final sixteen baseline UI tests pass; production builds split module pages
and the widget into lazy chunks. Geist/Geist Mono and their licenses are local.

Portrait preparation applied orientation, removed EXIF/GPS/ICC/XMP, verified
metadata absence and recorded SHA-256. Both outputs were inspected visually.
They are only in `.gearbox/settings-community-demo/private-assets/portraits`
and prepared ignored UI output. No child photographs are tracked.

Release 21 is deployed with content-derived image tags. Initial full-path scene
(browser -> UI nginx -> Gateway -> EB, and remote Settings read) passed:
`01a14e72-1a97-71ba-a67a-42696d44b1fb`, sequence 27, appeared in Dasha's inspector
and second-tab card; that card reread Settings and recorded one celebration.
Ilya remained false, recorded zero celebrations and zero foreign-tenant frames,
and never displayed that event. Screenshot `.gearbox/phase5-family-scene.png`.
Additional UI conflict, registry, reconnect/replay and scalar checks completed
successfully in the final phase-5 acceptance below.


Phase-5 acceptance completed on the real minikube deployment. Final images:
Gateway `sha256:5872ec82c6deaf4d8ef6fccfba61321ab97cd4827128308a3df9361ff8f64bfe`,
Settings `sha256:51f64e074f88d669d99cf428c36f022436b1a38023f7b76982f254c09cb68cdc`,
UI `sha256:a000255e6ce92f2cc49f993a25b099cd7f930548ae9beabe957a03302f9cbedd`.
Release 23 is ready. The earlier producer cursors/consumer group survived and
the topic and Directory registration were restored by startup, verified without
re-registering test declarations (`phase5-persistence-proof.json`).

The final widget logic serializes initial/reconnect/event reads. Scene event
`01a14e7a-177e-7333-9f2d-be85b5fb161e` (sequence 35) appears in both Dasha cards
and the inspector; each card rereads effective Settings and celebrates once.
Ilya stays false with no Dasha event or celebration. Evidence:
`phase5-final-scene-proof.json`, `phase5-family-scene-final.png`. A further
live transition explicitly produced 32 displayed confetti particles
(`phase5-confetti-dom-proof.json`); initial true and replay are excluded by
state/timestamp checks and event-ID deduplication. Reduced motion disables the
animation. Browser reload with existing true recorded zero celebrations.

A real pod upgrade interrupted the stream; it automatically rejoined/resumed
and returned connected after four transient attempts, with no replay celebration
(`phase5-reconnect-proof.json`). Manual reconnect retained one copy of each
rendered event. SDK fault tests additionally verify SEEK positions, duplicate
replay suppression and failed processing without checkpoint advancement.

Gateway registry showed 47 visible entities; the Settings source showed all
three Family Labs schemas, including JSON for approval. Discovery showed the
Settings OOP instance at version 0.1.0. Both real accounts called OAGW and got
their own upstream/owner-tenant markers and the matching request ID. History
showed the actual string mutation and its change-set/request ID. Empty number
input was rejected; 3.5 and a changed string were saved and restored. A stale
second editor received the conflict message, retained its draft, disabled Save
and recovered only after explicit Reload (`phase5-etag-conflict.png`).

Current verification: 16 UI tests, UI production build/Docker build, 80 engine
library tests, 7 actual-corpus community tests, UI backend-closure test, full
GDL/IR/lock suites, TypeScript export/determinism, strict Helm checks and Clippy
for the affected engine and demo adapters. Private-input scan covered 56 changed
or new source files and found no private identity/credential values or portraits.
Responsive styles include a narrow-screen navigation/layout; visual acceptance
here used the available desktop browser. Mac rehearsal remains phase 7.

The full Studio build needs its native npm prerequisites, now being prepared for
phase 6. Windows npm installation found the standalone SDK but node-gyp did not
recognize it as a Visual Studio component; no Studio-build success is claimed
yet. Binary file plans have a matching plaintext fallback in Studio's type map;
their actual text preview remains unavailable.


## Phase 5 — Claude Opus 5.5 high review follow-up

Review: `.gearbox/phase5-claude-review-opus55-high.txt`, confirmed actual model
`claude-opus-5-5`, high effort, source-only packet for commits 6505528/1c2046fd6.
The reviewer found no proven break in the demonstrated scene. Its raw-registry
bypass condition is confirmed from the V1 SDK contract (instance listing is
explicitly unscoped). Gateway diagnostics now read that SDK locally and filter
before returning; the public raw GET route is bootstrap-only. Settings registry
reads remain through the fixed private worker Service, with caller identity and
the same own-tenant/public-schema response filter.

Processor errors are now wrapped separately from stream authentication errors;
401/403 during Settings processing retry without advancing the checkpoint or
falsely asking for an EB login. The demo waits for its required event processor
before streaming, resumes after persisted pagehide/pageshow, bounds effective
reads, and avoids resetting retry backoff merely because SSE headers arrived.
OAGW is now an explicit UI backend requirement and its echo path is product
configuration. The worker registry target uses namespace-local Service DNS.
Twenty-three UI tests currently pass, including terminal/topology, heartbeat
timeout, expired-checkpoint/Start-live and back/forward-cache restoration cases.
The registry adapter tests and Clippy also pass. Runtime acceptance of this
follow-up is included in the next prepared-bundle deployment.

Review L5 is not a defect: toolkit-http HttpResponse::json already checks HTTP
status via checked_body_impl (libs/toolkit-http/src/response.rs). Known binary
extensions now remain Binary even for UTF-8-compatible bytes, and writer plans
explicitly suppress their text preview. The UI images are local-only private
artifacts; no image push or public ingress is part of the runner. ICC-to-sRGB
conversion is optional because the prepared photos passed visual inspection.

Existing phase-2/3 browser negative checks already rejected sibling reads,
writes and subscriptions; the review packet did not contain those earlier
receipts. Anonymous browser groups can remain when cleanup overlaps a broker
outage (the API has no TTL); phase-7 cleanup will target only identified stale
demo groups. No claim of automatic server TTL or REST ACK is made.


## Phase 6 — implementation and acceptance in progress

The prepared runner now performs preflight, generation, cached image builds,
content-addressed local image pinning, persistent infrastructure, Helm and API
smoke checks. Its private machine configuration is
`.gearbox/settings-community-demo/machine.json`; the verified output will be
`.gearbox/settings-community-demo/bundle.json`. The original Firebase handoff
remains `.gearbox/firebase-preflight/`; preparation reuses it without cloud login.
The UI npm lock is tracked and declared in GDL. Input fingerprints include the
shared UI SDK/shell as well as Rust dependencies and product configuration.

Studio runs natively in WSL on Node 24.21.0. Its native keytar module loaded and
node-pty executed a real shell command. TypeScript and Theia browser/backend
bundles build successfully. The separate Studio test profile opens the prepared
product and resolves minikube with zero errors. No AI chat calls are required.
Windows native npm build remains dependent on its missing VS Spectre libraries;
this environment uses the working WSL backend instead of changing that setup.

The host deployment service retains jobs across frontend disconnects, uses a
stable operation ID and Check status, and only accepts the fixed product/profile.
Four bounded service tests pass, including historical-status lookup while another
operation is active and refusal to treat process exit alone as readiness.
Five bundle-state tests pass, including shared UI source drift. Fifty-five
writer/generation integration tests and affected Clippy checks pass. Repeated
generation skips dependency/build caches and operator symlinks when auditing
orphan files; actual generated orphans are still reported.

The complete prepare/deploy and real Studio button acceptance are still running.
No Mac rehearsal, backup/restore or phase-7 completion is claimed here.


Phase-6 runtime attempt reached generated/build/pinned/loaded images and started
Helm, but did not produce a successful Helm/readiness receipt. Ubuntu's ext4 root
and the owned Docker data root remounted read-only; new executables returned I/O
errors. Registry inspection located the distro at `D:\WSL\Ubuntu\ext4.vhdx`
(656,211,443,712 bytes). Windows D: had only 15,265,792 bytes free while Linux df
had advertised room inside its sparse VHD. C: still had over 500 GiB, but not
enough for a full copy of this VHD. No repair, forced rw remount, WSL shutdown,
user-file deletion or automatic data reset was attempted.

The bundle remains unverified; phase 6 is NOT complete. A new physical-host-volume
preflight now rejects this actual environment before launching WSL. Two resource
regressions plus six bundle checks pass. Added Helm artifacts are rejected as
well as modified files, and input/artifact checks run again before readiness is
certified after a long deployment. Host recovery needs disk space and
approval to interrupt other Ubuntu processes. Guidance consulted:
https://learn.microsoft.com/en-us/windows/wsl/disk-space#how-to-repair-a-vhd-mounting-error.
Claude review and runtime acceptance resume after WSL recovery; do not re-run
Firebase setup. The product panel's dirty-editor gate now observes model dirty
and disposal events, including editors opened after the panel.


### WSL recovery after host disk exhaustion

The user freed over 100 GB on D: and authorized restarting Ubuntu. Terminating
Ubuntu succeeded, but its first start returned code 6/failure step 2. A complete
WSL shutdown then allowed Ubuntu to boot with a writable ext4 root. An actual
temporary-file write/read/remove probe passed. No fsck, forced rw remount,
namespace/PVC deletion or database reset was required or attempted.

The prior isolated Docker service was transient. It is now a persistent enabled
`gearbox-demo-docker.service`, using the same `/var/lib/gearbox-demo/daemon.json`,
Docker data root and socket. Its owned start script recreates only the private
`gbxdemo0` bridge at 172.30.0.1/24 and refuses a conflicting bridge address.
Docker identity remains `84b883e2-c501-4735-98e1-f72c5df0c621`.
The owned Postgres volume label survived and pg_isready accepts connections.
Application data and SQLite integrity still require the resumed runtime checks.

The host-volume probe now explicitly exports the distro name via WSLENV when
Linux invokes Windows PowerShell. Its real WSL-to-Windows check passes against
the freed D: volume, as do all eight bundle/host regressions. The current Studio
TypeScript and browser/backend builds pass after recovery. The previous bundle
is still unverified/stale and must be prepared again before Studio Deploy.


Recovery exposed a real restart race: Docker dynamically assigned Postgres the
stopped minikube node's static 192.168.58.2 address, preventing the existing node
container from starting. The owned Postgres endpoint was moved to fixed
192.168.58.10 with the same container and data volume; pg_isready passed.
Provisioning now creates it at host .10 of the named minikube /24 network and
validates that reservation instead of permitting dynamic allocation. It refuses
an existing unreserved endpoint rather than silently disconnecting a live DB.
No minikube deletion, network database deletion or volume recreation was used.


The interrupted disk-full upgrade left Helm revision 24 pending-upgrade. The
runner now checks the named release before any build and before a deployment,
and reports an unfinished Helm operation rather than starting another upgrade.
This was reproduced against the actual pending release; preparation stopped
before generation/build. Recovery uses an explicit rollback to successful
revision 23, preserving the retained PVC and external DB.

A further host-only startup race was identified: the original WSL Docker daemon
failed after replacing global Docker FORWARD chains, leaving the isolated
bridge without its forwarding rules. The isolated service is now ordered after
`docker.service`. Restarting only that owned daemon regenerated its bridge
rules; the existing minikube container restarted and its real TCP connection to
Postgres at 192.168.58.10:5432 passed. No manual firewall bypass or removal of
Docker network metadata was used. The waiting first rollback client was stopped
and recovery was retried after network restoration.


Resumed full preparation passed generation, cached builds, immutable image checks,
Helm revision 27, readiness, remote Settings, Directory, worker V1 registrations,
actual PV Retain and Google verifier connectivity. The bundle was certified.
A real Studio Deploy then produced only operation
`1fe2b726-85c7-4132-b228-18fe9b401357` and Helm revision 28. Reloading the frontend
while it was running retained the host job; reopening the product restored its
six progress stages, ready state and Open UI. No build ran in that deployment.
The managed localhost:8080 UI returned 200 and opened the real Google sign-in UI.

Existing real-account product sessions at 4175 authenticated against the new
backend. Gateway V1 registry returned 47 visible entities; Settings showed all
three Family Labs schemas. A new false/true Settings transition produced event
`01a14ef8-9bb2-70dd-bba3-4b867457ae3f` in the inspector and both Dasha widgets;
both reread Settings and recorded one celebration. Ilya retained false, no event
ID and zero celebrations. Initial true after reload did not celebrate.
Evidence: `phase6-scene-proof.json`, `phase6-live-scene.png` (ignored artifacts).

The original phase-1 event `32496472-c28c-4069-a21f-52fa24181e6f` was actually
re-read through SSE after recovery, along with original consumer group and
producer cursors; Dasha true/Ilya false survived. This probe deliberately did
not re-register declarations. Receipt: `phase6-recovery-persistence-proof.json`.
An added unverified Helm template was rejected by actual CLI validation and the
clean bundle validated after removing that probe (`phase6-stale-artifact-proof.json`).

Killing only the managed 8080 forward produced the lost-connection state and
Reconnect UI restored HTTP service without a deployment. This exposed a stale
error message after successful reconnect; the host now clears it on connection
readiness, covered by the fifth deployment-service test. Final rebuilt-host
reconnection verification and Claude review remain before closing phase 6.


### Phase-6 review and final recovery checks

The last 69e1ac7 preparation passed (Helm revision 29). The rebuilt Studio
host's actual lost-forward/reconnect check cleared the previous error and
restored Open UI (`.gearbox/phase6-reconnect-final.png`). A subsequent probe
through nginx received topology/heartbeats but not the old event. The same
failure reproduces on a fresh direct Gateway forward, including a new consumer
group. Read-only inspection confirms both SQLite stores pass integrity_check;
the original root event is still sequence 2 in the retained event log. This is
an unresolved delivery/read regression, not a demonstrated data loss. Do not
claim post-restart SSE acceptance until it is fixed and rerun.

Claude completed a source-only review of 30a7a1a..69e1ac7 on actual
claude-opus-5-5/high (`.gearbox/phase6-claude-review-opus55-high.txt`). Follow-up
changes make fingerprints content-based using a private Git index, distinguish
Studio host epochs, retain live forward state during historical receipt lookup,
preserve deployment errors when a forward closes, pin generator copies, take
inputs before generation, check rendered image references and exact npm lock
bytes, and replace stale PID-file locking with an OS-owned loopback mutex.
Eight deployment tests passed before the additional epoch-identity case.
The auto-build path now remains incremental but rebuilds on each prepare;
explicit operator-supplied binaries are pinned without claiming a source build.

The first WSL native-Git fingerprint attempt omitted WSLENV for its temporary
index. It staged only this task's known edits in both repositories. That specific
preparation tree was stopped, those task edits were unstaged, and no working
files were reverted. WSLENV now exports the private index path and literal-path
setting. An actual WSL -> Windows Git regression verified stable digests and
byte-identical real indices in both checkouts. Real user staging must remain
untouched by subsequent preparation.


The delivery failure was narrowed to scheduler starvation, with retained data
intact. Per-fetch trace showed every fetch at offset 40 and none at offset 0
while a new replay subscription reported topology offset 0. Three older live
readers at an empty tail accumulated starvation credit on every scan, including
scans that selected their empty fetch. A later replay reader gained credit at
the same rate and could never outrank them. This can occur with client
checkpoints after restart, or with any late replay consumer.

Regression `empty_popular_tail_does_not_starve_a_late_replay_reader` first failed
against the original scheduler. The fix resets the selected position's waiting
credit when its fetch is selected (including empty speculative fetches), while
unselected readers keep accumulating credit. The fixed regression and complete
EB library suite pass: 608 passed, 7 existing named-group tests ignored, 0 failed.
Actual image redeployment/SSE replay and Clippy are still pending at this point.
The lightweight offset/count/error traces are disabled at the normal log level;
temporary runtime trace settings must be removed by final preparation.

Additional readiness recovery: after a Gateway replacement, a live worker may
not yet have sent its next Directory heartbeat. Smoke now bounds the wait for
that re-registration instead of requiring it immediately. The updated prepare
passed after that change. Harness replay no longer re-registers declarations,
SEEK echoes the actual topology version, and identity checks now use the
filtered registry adapters while requiring raw registry access to be denied.
These updated identity cases still need the final runtime pass.

An attempted extra source-only Claude diagnosis of the unfinished EB failure
was rejected by automatic approval review: authorization covered completed-phase
reviews, not exporting this unfinished diagnostic packet. No packet was sent;
local source/runtime diagnosis continued. The completed phase-6 review above
remains the actual review receipt.


### Phase 6 — implementation and Windows/WSL acceptance passed

EB fix is committed in gears-rust as `440ee2d0e`; Clippy with `-D warnings`
passed after the 608/7 library result. Full preparation of that source passed,
then the original sequence-2 event was re-read through localhost:8080/nginx in
under a second without re-registering declarations. Dasha true/Ilya false,
original consumer group and producer cursor were preserved. The actual remote
Settings/outbox event was also replayed (`01a14f09-8ff9-7203-860d-5babb8597346`)
and its temporary laboratory-message change was restored through the API.
The updated technical identity check passed, including denied worker access to
Directory/raw and filtered registry diagnostics. Updated real-user harness cases
remain distinct from the already verified signed-in product sessions.

Final Studio operation `3df4bcc8-d5d2-4323-b5b1-db76506cf92e` completed all six
progress stages, readiness and the managed Open UI connection. No image or Rust
build ran during it. Screenshot: `.gearbox/phase6-final-deploy-ready.png`.
Nine deployment-host tests, ten bundle/host/mutex tests, TypeScript and the full
Theia browser/backend build pass. The generated npm-lock byte comparison and
rendered Helm image allowlist passed during actual preparation/deployment.
Source fingerprinting now preserves the user's real Git index in both native
Windows and actual WSL-to-Windows Git probes.

Backend-restart limitation remains explicit. Deliberately stopping the Studio
wrapper during operation `3a929c18-de7b-4419-b973-3c751d320e49` at validation
also ended its runner in this WSL launch environment despite detached spawn.
The receipt stayed nonterminal, Helm remained deployed at revision 32 and no
second operation was started automatically. After reconnecting/reloading Studio,
the panel correctly reported the previous host session ended. Only after checking
the cluster was a new operation started explicitly; it is the successful final
operation above. Frontend reload survival is proven by the earlier mid-Deploy
check; backend restart during Deploy is not supported/claimed. Reload the
frontend after restarting the backend; do not restart the host during a talk.

Completed-phase Claude review findings P1/P3/P4/P5/P6/P7 and image/npm-lock
verification have bounded fixes and checks. P2's input scope excludes Studio,
README and verification/test helpers. C1 uses an OS-owned local mutex rather
than PID-file takeover. Docker memory now requires 6 GiB. Registry adapter
routes remain read-only at the handler layer; the all-method policy prevents
non-GET requests falling through to demo:user. Broad cache-directory orphan
exemptions and uncommon WSL BasePath prefix forms are low-risk limitations of
this bounded setup, not new acceptance claims.

The portable commands are implemented; no actual Mac rehearsal is claimed.
The phase-7 maintenance implementation and English runbook are being completed;
backup/restore/offline acceptance and presentation-device checks are still open.


### Phase 7 — maintenance and reserve implemented; available-host acceptance passed

Explicit offline product/profile uses strict static authentication with two
separate laboratory credentials. The shell marks Offline Demo / Static identity
and keeps its lab token only in memory. It never launches Google login in that
mode; normal Firebase configuration and saved sessions remain intact. Backend
images are reused only after normal input/image validation and exact generated
Rust/normalized Cargo composition comparison. Normal/offline UI images were
scanned inside network-disabled read-only containers: none of the six private
runtime credentials appeared in static assets. No credentials or portraits are
tracked. Generated UI TypeScript and 23 UI tests passed; 12 bundle/mutex/archive
checks passed in the final maintenance pass.

Actual offline scene: event `01a14f3e-2e03-7026-847a-4b9fb2f2859c` reached both
Dasha clients, each reread effective Settings and celebrated once. Ilya remained
false with zero celebrations. Proof: `.gearbox/phase7-offline-scene-proof.json`
and `.gearbox/phase7-offline-scene.png`. Returning with normal Deploy restored
all three existing Google browser sessions without another manual login.

Controlled backup/restore passed with private snapshot
`offline/backups/20261018T133617Z-fc54e752`: quiesced both writers, saved both EB
SQLite stores and four dedicated external Postgres DBs, then reset both approval
values through APIs and restored the snapshot. Dasha true/Ilya false returned,
as did the original sequence-2 event `32496472-c28c-4069-a21f-52fa24181e6f`,
original consumer group and producer cursor. No business seed registration ran
during replay. Proof: `.gearbox/phase7-backup-restore-proof.json`. An inspector
checkpoint beyond the restored log correctly reported checkpoint_unavailable;
Start live and baseline reload recovered it. This must be done in each affected
tab. Static reload requires its lab token again.

Cleanup removed 36 old anonymous Browser-UUID groups in the two lab tenants,
only after confirming no remaining subscriptions. Active groups and the original
business fixture were retained. This is explicit maintenance, not a broker TTL.

The existing gearbox-demo profile was stopped/started with minikube, keeping the
same namespace/PVC/PV UIDs, Postgres container ID, named data volume and fixed
network address. After cluster DNS warmed nginx recovered from host-not-found
startup retries; a first rollout status had reflected stale readiness, so actual
HTTP/API/SSE checks were required. All four pods became Ready. Original event,
group, cursor and Dasha true/Ilya false passed again through nginx. Proofs:
`.gearbox/phase7-stop-start-proof.json` and
`.gearbox/phase7-stop-start-persistence-proof.json`. This is stop/start of the
existing profile, never delete/recreate or a disk-loss claim.

After restart the real Firebase scene passed again with event
`01a14f43-2839-75fe-b51b-3abf9601b457`: same event in both Dasha clients, one
celebration each, Ilya false/zero. An editor intentionally left open across an
operator reset correctly preserved its draft and required Reload current value
on the ETag conflict; fresh tabs must be loaded after reset before presenting.
Proof: `.gearbox/phase7-firebase-scene-proof.json` and its screenshot.
Gearbox Reconnect UI restored Open UI without another deployment.

The English runbook is `docs/demo/settings-community-demo-runbook.md`. It covers
the presentation steps, exact private config/handoff paths, explicit mode/reset,
backup/restore, checkpoint and deployment recovery, and storage loss boundaries.
The approved plan file has not been edited.

External presentation acceptance remains explicit: no actual Mac, independent
browser contexts, presenter hotspot or complete rehearsal video were available
for verification here. Browser evidence uses separate session-persistent tabs
in one Chrome profile. These are preparation/rehearsal items for the actual
presentation environment, not claimed completed by these Windows/WSL checks.
