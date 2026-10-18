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
