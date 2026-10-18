# Family Labs presentation runbook

Run all commands from the Gearbox checkout. Use the `codex/settings-community-demo`
branch in both repositories. Keep the original feature-branch history; do not
rebase this demo onto main. The approved plan remains unchanged; the execution
notes record actual checks and limitations.

## Private operator configuration

On this machine the runner reads
`C:\projects\gearbox\.gearbox\settings-community-demo\machine.json`.
It contains the WSL distribution, native Node/generator/source paths, isolated
Docker socket and private kubeconfig. The Firebase handoff is already complete
under `C:\projects\gearbox\.gearbox\firebase-preflight\`:
`authn-demo-inputs.json`, `firebase-web-config.json` and `state.json`.
Both real Google identities were verified. Normal prepare/Deploy never runs
Firebase management login or recreates the cloud project.

Runtime credentials live in `.gearbox/settings-community-demo/private/`.
Verified, metadata-free portraits live in `private-assets/portraits/` beneath the
same work directory. These files, generated UI images, snapshots, identity
receipts and screenshots are private. Transfer them privately if moving hosts;
do not commit them, push images or publish an ingress.

## Prepare before presenting

1. Start Docker with Linux containers. Allocate at least 3 CPUs, 6 GiB RAM and
   enough disk for cached builds; keep 20 GiB free on the physical volume holding
   a WSL VHD. The one-node minikube profile requests 3 CPUs and 4600 MiB.
2. On the configured Windows/WSL host, run:

   ```powershell
   & 'C:\utils\nvm\installs\v24.21.0\node.exe' products/settings-community-demo/scripts/demo.cjs prepare
   ```

   On a newly prepared native host, install Docker, Node 24, Rust, kubectl and
   minikube, privately transfer the handoff/assets, then run:

   ```sh
   node products/settings-community-demo/scripts/demo.cjs prepare --source-root /absolute/path/to/gears-rust
   ```

3. Wait for `Prepared bundle, deployment and smoke checks passed`. Inspect
   `.gearbox/settings-community-demo/bundle.json` and `last-readiness.json`.
   Preparation builds; the presentation Deploy uses only these images.
4. Start the built Gearbox Studio, open
   `products/settings-community-demo/product.gdl`, select `minikube`, and resolve.
   The expected intentional notices include static DNS contract routing.
5. Press **Deploy** once. Wait for readiness and **Open UI**. Reloading the
   frontend retains the host operation. If an acknowledgement is lost, press
   **Check status**; never click a second deployment to guess its outcome.
6. Sign into the product with the already configured Google accounts. Prepare
   two Dasha tabs and an independent browser context for Ilya before the talk.
   A lab character/photo is separate from the actual signed-in account.
   Keep these exact tabs open: Firebase session persistence is per tab and origin.
   A fresh Open UI tab on port 8080 requires normal Google sign-in even when the
   verified rehearsal tabs on port 4175 are already signed in. This is browser
   sign-in, not another Firebase project/CLI setup.
7. Run the explicit scene reset while the service is healthy:

   ```sh
   node products/settings-community-demo/scripts/demo.cjs reset
   ```

   Both `Ice cream approved` values must be false. Reset changes only this
   boolean through the Settings API. Reload the prepared tabs after reset to
   load fresh editor ETags and a zero-celebration baseline. If an already open
   editor reports a preserved-draft conflict, choose Reload current value before
   editing again. Deploy itself never resets overrides.
8. Confirm `Live stream connected`, zero initial celebrations, all four modules
   accessible, and a successful OAGW echo. Rehearse on the actual presentation
   machine; Windows/WSL evidence does not establish Mac acceptance.

## On stage

1. **Gearbox composition.** Open the prepared product. Show Gateway and the
   separate Settings worker, and the four UI modules declared in GDL.
   Expected: the product resolves without errors; no manual gear configuration.
2. **Deploy.** Press Deploy, follow progress and Open UI.
   Expected: immutable prepared images, existing storage, working application.
3. **Settings.** Show Dasha's portrait and “Chief Ice Cream Officer”, and Ilya's
   portrait and “Head of Quality Assurance”. Show string, boolean and number
   settings, effective source and history.
4. **Live ice cream approval.** Put a Dasha Settings tab and a Dasha Event Broker
   inspector side by side. Change `Ice cream approved` to Approved and Save.
   Expected: a real event ID appears in the inspector; the second Dasha tab
   rereads remote Settings and displays “Approved. Deploy the ice cream. 🍦”.
   One celebration follows the event/read. Initial load, replay and duplicate
   frames do not celebrate; reduced-motion preferences are respected.
5. **Tenant separation.** Show Ilya still waiting for approval. Use prior
   automated acceptance results for security; do not perform a live isolation
   attack or delete pods on stage.
6. **Discovery.** Show registered gears, deployment mode and the remote worker's
   live instance. This is real Directory registration. Contract endpoint
   resolution in this demo uses declared Kubernetes Service DNS.
7. **Types V1.** Select Gateway, then Settings explicitly. The worker's three
   Family Labs setting schemas are separate from Gateway's registry. V1
   registrations are process-local and restored at startup; this is not V2.
8. **OAGW.** Invoke the echo action. Show response, request ID and private
   upstream. The browser uses the incoming Gateway; OAGW calls the internal
   echo workload under its allowlisted demo HTTP policy.
9. **IDE.** Show product GDL, generated workspace, typed Toolkit contracts,
   backend configuration, UI module registry and Helm resources. AI chat is
   optional and is not required for the demonstrated deployment.

Run cleanup with presentation tabs closed; its subscription checks and the broker
active-member guard do not provide a distributed maintenance lock against a
concurrent reconnect.

Cluster primitives are configured with the external Postgres provider and are
used by EB cache/routing/ingest notification paths. Delivery also uses bounded
partition-loader polling/local notification. Do not describe native prefix watch
as active or claim a browser REST ACK. Inspector recovery uses scoped client
checkpoints, JOIN/SEEK and event-ID deduplication.

## UI connection and deployment recovery

- **Studio backend restart:** do not restart Studio while Deploy is running.
  In this WSL launch mode the runner can be interrupted with its host. Reload
  the frontend after a backend restart, inspect the operation/cluster and recover
  any pending Helm revision before explicitly starting a new operation.
  Frontend page reload during a running Deploy is supported.
- **UI connection lost:** press Check status if the panel still shows Open UI,
  then Reconnect UI. It restores the owned loopback
  forward without redeploying. A Service port-forward binds one pod; a successful
  deployment reconnects it to the current workload.
- **Missing/stale bundle:** run prepare before presenting. The error identifies
  source, private input, generated artifact, image, generator or target drift.
  Committing identical prepared content should not invalidate the fingerprint.
- **Missing Secret / readiness error:** inspect the private operation logs. Do
  not replace credentials or delete data. Re-run preparation after fixing the
  reported input or connectivity problem.
- **Pending Helm operation:** the runner refuses another upgrade before any
  build/deploy. Inspect only release `settings-community-demo` in namespace and
  context `gearbox-demo`; explicitly roll back to its last successful revision.
  Do not delete Helm Secrets or the namespace/PVC to clear a pending status.
- **WSL read-only / I/O errors:** restore physical Windows disk space first.
  A WSL restart interrupts other distro processes and is an operator action.
  This host's isolated daemon is `gearbox-demo-docker.service`, using
  `/var/lib/gearbox-demo/daemon.json` and its existing data root. The original
  Docker daemon is separate. Never remove Docker network metadata or database
  volumes to make a startup error disappear.

## Consistent private backup and restore

Stop presentation writes before maintenance. Close live inspector tabs to avoid
client checkpoints advancing while the data is being restored; an open read-only
inspector does not change the server snapshot.
`backup`/`restore` acquire the same host mutex as prepare/deploy and verify the
fixed cluster, owned workloads, retained claim and external Postgres volume.

```sh
node products/settings-community-demo/scripts/demo.cjs backup
```

The command stops Settings, waits for its pods to disappear, then stops Gateway
and waits. It copies the entire EB volume, including both SQLite databases and
any WAL/SHM companions, and logically dumps only the four dedicated Postgres
DBs: `credstore`, `settings_service`, `types_registry`, `gearbox_demo_cluster`.
It also saves an allowlist of private product inputs, processed portraits and
the existing Firebase handoff. Writers resume and readiness is checked. A backup
is marked complete only after the saved approval baseline matches a post-resume
API read. Keep all presentation writes paused throughout; the CLI mutex does not
lock browsers. A changed baseline requires another backup.
A partial directory without a complete `snapshot.json` is not a usable backup.

Use the matching `backup-offline`, `restore-offline`, `reset-offline` and
`cleanup-offline` commands while the reserve mode is deployed. Maintenance refuses
a mode that differs from the running workload.

The returned backup ID selects only a directory beneath
`.gearbox/settings-community-demo/backups/` (or `offline/backups/` for the reserve). Copy the complete private directory
to separate storage. A copy on the same physical disk is not disk-loss recovery.

```sh
node products/settings-community-demo/scripts/demo.cjs restore --backup EXACT_BACKUP_ID
```

Restore verifies all file hashes and the bounded SQLite archive format before
stopping writers. It requires the original credentials/assets and compatible
backend source/migrations. It restores the isolated demo databases and complete
EB state, resumes Gateway then Settings and checks readiness and saved approval
values. If a multi-store restore fails, writers stay stopped: fix the reported
cause and retry the same snapshot before resuming. Never start the presentation
against a partial restore. The original failure is retained and additional helper
cleanup/resume failures are reported separately. If quiesce itself failed, shutdown
may be partial: inspect replicas instead of assuming both writers are stopped.

Before another archive operation the runner checks for an existing pg_dump or
pg_restore process inside the owned Postgres container. A timed-out Docker client
can leave its in-container process running. Inspect/wait for that process before
retrying; do not overlap restores or kill unrelated services.

For a lost minikube profile, privately restore the snapshot's input files and
Firebase handoff to their original relative work directories, check out the
source content matching the recorded backend/input digest, prepare compatible
images/infrastructure, then restore
the selected snapshot. A restored snapshot may rewind the event log; if an
inspector reports an out-of-range client checkpoint, use **Start live** and
reload/verify the baseline before the next approval. Browser checkpoints are
separate from server-side business cursors. Bundle revision/dirty metadata describes preparation time; a later content-only
commit can be valid without rewriting that metadata. Use execution-note commits
and the required digest when locating those sources. Source checkouts and tools
must also be available; this
snapshot is not a universal whole-machine backup. Controlled restore acceptance
and actual host-specific reboot acceptance are recorded separately in execution
notes.

Pod replacement and repeated Deploy preserve the retained PVC. The default
minikube StorageClass has a Delete reclaim policy; this product provisions its
own Retain class and checks the actual PV. Minikube stop/start preserves the
hostpath data in the existing profile. After start, wait for actual pod readiness
and an HTTP/API smoke check; an immediate rollout status can briefly reflect old
readiness. On this host nginx restarted while cluster DNS was warming and then
recovered without data changes. `minikube delete` destroys that environment:
restore from backup regardless of Retain. A PVC is not a backup against loss of
its host, VHD or physical disk.

## Reserve presentation

Prepare the reserve before going on stage:

```sh
node products/settings-community-demo/scripts/demo.cjs prepare-offline
```

It uses `product.offline.gdl` / `minikube-offline`, separate private bundle files
under `.gearbox/settings-community-demo/offline/`, and the same owned cluster,
namespace and data. The generated compiled composition must match the normal
verified backend before its images are reused. Only deployment authentication
configuration and the visible UI mode change.

Choose the reserve explicitly with `deploy-offline`, then `forward-offline` (or
Reconnect UI in the running Studio) and reload the product. Sign into its lab
tabs using only `DEMO_OFFLINE_DASHA_TOKEN` / `DEMO_OFFLINE_ILYA_TOKEN` from the
private offline runtime-secrets file. Do this before presenting that mode. The
shell retains these credentials in memory only. It visibly labels the session
**Offline Demo / Static identity**. Unknown tokens and sibling access must fail;
Google sign-in is not attempted. Never paste operator/worker tokens into UI.
Preparation refuses a reserve copy whose shared technical credentials or portraits
differ from the normal inputs; review and refresh that private copy explicitly.

Use normal `deploy` to return to the verified Firebase mode and reload UI. The
existing Google provider/project/accounts stay configured throughout. Do not
show a static identity while describing it as Google OAuth.

Prepare a working hotspot and a recording of a complete successful rehearsal.
These require the presenter's actual devices/environment. The available-host
checks and remaining target-device acceptance are recorded in execution notes;
never silently replace Google authentication or weaken Firebase/cloud
configuration during the talk.
