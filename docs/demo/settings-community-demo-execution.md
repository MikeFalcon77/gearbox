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

1. Prepared product, per-gear SQLite platform database, persistent Kubernetes
   storage, external Docker Postgres, and real inter-process routing.
2. Existing Firebase integration, technical authentication, policy and bootstrap.
3. Remote Settings contract, transactional outbox to EB, Cluster and OAGW.
4. UI SDK, shell, GDL declarations and generated frontend deployment.
5. Four UI modules, professional design, private photos and the ice cream scene.
6. Prepared bundle, image warming and one-click Deploy in Gearbox.
7. End-to-end checks, persistence and recovery, runbook and presentation rehearsal.

No phase after 0 has been declared complete. Final Mac rehearsal needs evidence
from the actual presentation machine; Windows or WSL checks cannot substitute.
