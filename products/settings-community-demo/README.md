# Family Labs community demo

The approved scope and verification record are in
[the plan](../../docs/demo/settings-community-demo-plan.md) and
[execution notes](../../docs/demo/settings-community-demo-execution.md).

This product is prepared before presenting. The target flow is **Open product →
Deploy → Open UI**. AI chat and manual gear composition are optional.

The backend composition runs in minikube: Gateway, Event Broker, Discovery,
Types Registry V1, OAGW and a separate Settings worker with its own AuthN stack.
Its real routing and EB persistence checks pass across pod recreation, repeated
Deploy and the available Windows/WSL minikube stop/start. The four UI modules and
prepared Studio Deploy are implemented. Target-machine rehearsal and current
acceptance outcomes are recorded in the execution notes. Firebase integration
is configured in `auth.gdl`.

## Storage and authentication

EB metadata is `/var/lib/gearbox/event-broker/metadata.sqlite3`; its event log is
`/var/lib/gearbox/event-broker/events.sqlite3`. Both are on
`gearbox-demo-gateway-data`. The actual PV must use **Retain**. The workload has
one replica and uses **Recreate**. Deploy never deletes its claim or namespace.
Minikube stop/start preserves this data. Minikube delete requires a separate
backup and restore; Retain cannot preserve a deleted cluster's host filesystem.

Postgres runs in the external Docker container `gearbox-demo-postgres`, with
volume `gearbox-demo-postgres-data`, on the private minikube Docker network. Its
operator port binds to `127.0.0.1:55432`. Kubernetes connects through the
`external-postgres` Service and a host-specific EndpointSlice. No database server
is deployed in Kubernetes. The read-only `db-probe` Job is a SQL client.
The backend init containers run only `pg_isready`, waiting for cluster DNS and
the external server before application migrations start.

Run `node scripts/prepare-inputs.cjs` to create private runtime inputs under
`.gearbox/settings-community-demo/private/`. Repeating it preserves credentials.
Do not commit, print or bake these files into images. Platform-plane shared
secrets enter typed runtime config through `APP__` environment overrides; the
tracked empty values cannot authenticate a caller. Technical bearer credentials
use strict static token matching with environment expansion.
The resolver selects the explicit demo adapter. JWT-shaped tokens go to Firebase;
opaque technical tokens go to the strict static SDK. Rejection never causes an
authentication fallback. Bootstrap and worker have distinct identities and scopes;
the action policy delegates concrete tenant checks to the hierarchy plugin.

`demo-catalogue` restores each process's V1 event declarations through the Types
SDK. `family-labs-bootstrap` reconciles Settings declarations after migrations,
before worker readiness. Restarts preserve tenant overrides and restore derived
setting types. There is no public bootstrap endpoint.

Firebase is already configured and both accounts were verified. The existing
handoff is `.gearbox/firebase-preflight/authn-demo-inputs.json`, with
`firebase-web-config.json` and `state.json`. Do not recreate the Firebase project
or require a new Firebase CLI login for normal deployment.

## Preparation helpers

Use the new demo branches in both checkouts. Configure the source root with id
`gears-rust`, pointing to the demo checkout. Relative paths are used inside the
generated workspace and Linux build context.

The helper scripts are intentionally separate from the presentation:

1. Generate the product for `minikube` into
   `.gearbox/settings-community-demo/minikube` using the Gearbox CLI.
2. Run `prepare-inputs.cjs` and `prepare-chart.cjs` with Node 24.
3. Build both generated backend images with the generated `docker/build.sh`.
4. Use `provision-postgres.sh` for the owned external database and its volume.
5. Use `provision-cluster-storage.sh` for retained storage, Secrets and the
   external database endpoint; it refuses unrelated resources.
6. `verify-chart.sh` renders with real Helm and checks rejection of unsafe SQLite
   overrides. `deploy-bundle.sh` loads prepared images and waits for readiness.

On WSL use the isolated Docker socket
`unix:///run/gearbox-demo/docker.sock`, private kubeconfig
`/home/mike/.config/gearbox-demo/kubeconfig`, and context/profile `gearbox-demo`.
Scripts honor `DOCKER_HOST` and `KUBECONFIG`; they never change global contexts.
Helm is downloaded with checksum verification into a private tool cache.

The product-owned `deploy/extra-templates` files are copied into the generated
umbrella chart by `prepare-chart.cjs`. They supply the private HTTP echo helper;
they do not replace generated backend workloads. Final preparation and one-click
Deploy will wrap these stages and validate input/image fingerprints.

## Identity integration checks

With a loopback-only forward to Gateway on `127.0.0.1:18087`, run:

```sh
node products/settings-community-demo/scripts/verify-identities.cjs technical
node products/settings-community-demo/scripts/verify-identities.cjs
```

The second command serves `http://localhost:4174`. Sign in with each already
configured Google account to verify real backend authentication, tenant mapping,
own-tenant writes and rejection of sibling Settings access and EB subscriptions.
It also checks read-only diagnostics and rejection of schema/producer mutations.
Only outcomes are saved under ignored private storage; user tokens are never
saved. The technical check verifies the restricted worker credential, allowed
demo publications and denied root/unknown tenants and foreign event types.

This is a development integration harness, separate from the final product UI.


## Prepared local deployment

The product is opened from `products/settings-community-demo/product.gdl`.
Its source locator uses the private alias created by preparation; checkout
folder names do not have to match this machine. All application copy is English.

Before preparing another machine, privately transfer the existing Firebase
handoff into `.gearbox/firebase-preflight/` and the verified portraits directory
into `.gearbox/settings-community-demo/private-assets/portraits/`. Keep existing
runtime credentials with the external Postgres data volume. Preparation reuses
the existing Google provider and identities; it never runs Firebase CLI login
or creates a cloud project.

With Docker, minikube, kubectl, Node 24 and Cargo available on the presentation
Mac, run from the Gearbox checkout:

```sh
node products/settings-community-demo/scripts/demo.cjs prepare --source-root /path/to/gears-rust
```

The command records private machine paths, checks the local Docker resources,
starts only the `gearbox-demo` profile, builds the generator, generates the
product, builds/pins all images, provisions the owned Docker Postgres volume
and retained PVC, deploys, and checks readiness/remote APIs/Google connectivity.
Helm is installed into a private tool cache with checksum verification.
`machine.json` may name a previously built native generator explicitly.
The Windows launcher can delegate to the configured WSL distribution/Node;
these machine-specific paths remain in the ignored work folder.

The tracked UI npm lock is declared through `ui_product(npm_lock=...)`; a fresh
UI generation can run `npm ci` without resolving dependency ranges again.
The generated `ui.lock.json` includes the npm-lock hash. The prepared bundle
also records source revisions/dirty-input digests, the generator binary hash,
private-input digest, generated file hashes, exact image IDs/architectures,
cluster identity and readiness receipt. Source, private asset, artifact, image
or target drift makes Deploy fail with a reason to prepare again.

Open the product in Gearbox and press **Deploy**, then **Open UI**. Deploy uses
prepared images and preserves the existing databases/PVC. It does not build,
rotate credentials, delete namespaces/volumes/profiles or change Firebase setup.
Progress streams to the product panel. A lost RPC acknowledgement requires
**Check status**; it never automatically starts a second operation. **Reconnect
UI** restores the managed loopback-only port-forward on port 8080 independently
of deployment. A stopped cluster must be warmed through preparation first.

The UI images contain the private family portraits. Keep them local: this
runner accepts local Docker endpoints and has no image-push or public-ingress
operation. It serves UI only through a ClusterIP service and loopback forwarding.
The portraits are presentation assets, not tenant-private backend records.

For the optional Windows-to-WSL launcher, preflight checks the physical Windows
volume holding the registered Ubuntu VHD in addition to free space reported by
Linux/Docker. Keep at least 20 GiB free there before preparation (4 GiB for a
prepared deployment). A read-only WSL root stops the runner. The runner does not
restart or repair the user's distribution automatically.


## Maintenance and explicit offline reserve

The English [presentation runbook](../../docs/demo/settings-community-demo-runbook.md)
contains the expected result of each on-stage step, recovery boundaries and
private backup handling. From the repository root:

```sh
node products/settings-community-demo/scripts/demo.cjs reset
node products/settings-community-demo/scripts/demo.cjs backup
node products/settings-community-demo/scripts/demo.cjs restore --backup EXACT_BACKUP_ID
node products/settings-community-demo/scripts/demo.cjs cleanup
```

Reset changes only `Ice cream approved` in the two demo labs through Settings
APIs. Backup quiesces both writers and saves both SQLite stores, dedicated
Postgres databases and an allowlist of private inputs. Restore is limited to a
verified private snapshot and compatible source/configuration. Cleanup removes
only old anonymous groups bearing this UI's Browser UUID description, in the
two lab tenants, with no remaining subscription. It retains active and business
groups. The broker API has no automatic consumer-group TTL.

The reserve product is `product.offline.gdl`, profile `minikube-offline`:

```sh
node products/settings-community-demo/scripts/demo.cjs prepare-offline
node products/settings-community-demo/scripts/demo.cjs deploy-offline
node products/settings-community-demo/scripts/demo.cjs forward-offline
```

Prepare the normal bundle first. Offline preparation checks that generated Rust
sources and normalized Cargo manifests are identical, then reuses the verified
backend images and builds the explicit offline UI configuration. Both modes
have separate private bundle directories and use the same bounded demo target;
they cannot run writer/deploy maintenance operations concurrently.

The offline resolver selects strict static authentication. Existing Firebase
code remains compiled but idle. Two separate laboratory tokens live only in
`.gearbox/settings-community-demo/offline/private/runtime-secrets.json`; enter
the appropriate lab token before presenting. They are never embedded in public
UI configuration or persisted by the shell. Use laboratory credentials in the
browser, never bootstrap/worker credentials. The product visibly says Offline
Demo. It does not silently fall back from Google or change cloud configuration.
Use normal `deploy` to return to the prepared Firebase product, then reload UI.
