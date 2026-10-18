#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
work=${DEMO_WORK_DIR:-$repo/.gearbox/settings-community-demo}
profile=${DEMO_MINIKUBE_PROFILE:-gearbox-demo}
context=${DEMO_KUBE_CONTEXT:-gearbox-demo}
: "${KUBECONFIG:?Set the private demo KUBECONFIG before provisioning.}"
k() { minikube -p "$profile" kubectl -- --context="$context" "$@"; }

# Never adopt unrelated resources, change the default StorageClass, or delete data.
if k get namespace gearbox-demo >/dev/null 2>&1; then
  owner=$(k get namespace gearbox-demo -o 'jsonpath={.metadata.labels.app\.kubernetes\.io/part-of}')
  test "$owner" = settings-community-demo || { echo 'Refusing an unowned namespace.' >&2; exit 1; }
fi
if k get storageclass gearbox-demo-retain >/dev/null 2>&1; then
  owner=$(k get storageclass gearbox-demo-retain -o 'jsonpath={.metadata.labels.app\.kubernetes\.io/part-of}')
  test "$owner" = settings-community-demo || { echo 'Refusing an unowned StorageClass.' >&2; exit 1; }
  policy=$(k get storageclass gearbox-demo-retain -o 'jsonpath={.reclaimPolicy}')
  provisioner=$(k get storageclass gearbox-demo-retain -o 'jsonpath={.provisioner}')
  test "$policy" = Retain && test "$provisioner" = k8s.io/minikube-hostpath || {
    echo 'Existing demo StorageClass has an unexpected policy or provisioner.' >&2; exit 1;
  }
fi
if k -n gearbox-demo get pvc gearbox-demo-gateway-data >/dev/null 2>&1; then
  owner=$(k -n gearbox-demo get pvc gearbox-demo-gateway-data -o 'jsonpath={.metadata.labels.app\.kubernetes\.io/part-of}')
  test "$owner" = settings-community-demo || { echo 'Refusing an unowned data claim.' >&2; exit 1; }
fi
k apply -f "$script_dir/../deploy/storage.yaml"
k -n gearbox-demo wait --for=jsonpath='{.status.phase}'=Bound pvc/gearbox-demo-gateway-data --timeout=90s
pv=$(k -n gearbox-demo get pvc gearbox-demo-gateway-data -o 'jsonpath={.spec.volumeName}')
policy=$(k get pv "$pv" -o 'jsonpath={.spec.persistentVolumeReclaimPolicy}')
test "$policy" = Retain || { echo 'The actual PV must use Retain before deployment.' >&2; exit 1; }
k apply --server-side --field-manager=gearbox-demo -f "$work/private/kubernetes-secret.json"
for resource in service/external-postgres endpointslice/external-postgres-demo; do
  if k -n gearbox-demo get "$resource" >/dev/null 2>&1; then
    owner=$(k -n gearbox-demo get "$resource" -o 'jsonpath={.metadata.labels.app\.kubernetes\.io/part-of}')
    test "$owner" = settings-community-demo || { echo 'Refusing an unowned external database endpoint.' >&2; exit 1; }
  fi
done
k apply -f "$work/private/external-postgres.yaml"
echo "Persistent claim is Bound; actual PV $pv uses Retain."
