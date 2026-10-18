# Family Labs community demo

The approved scope and verification record are in
[the plan](../../docs/demo/settings-community-demo-plan.md) and
[execution notes](../../docs/demo/settings-community-demo-execution.md).

This product is prepared before presenting. The target flow is **Open product →
Deploy → Open UI**. AI chat and manual gear composition are optional.

The backend composition runs in minikube: Gateway, Event Broker, Discovery,
Types Registry V1, OAGW and a separate Settings worker with its own AuthN stack.
Its real routing and EB persistence checks pass across pod recreation, repeated
Deploy and minikube stop/start. The UI and final Deploy integration are added
in subsequent phases. Firebase integration is configured in `auth.gdl`.

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
