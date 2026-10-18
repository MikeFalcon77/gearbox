#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
work=${DEMO_WORK_DIR:-$repo/.gearbox/settings-community-demo}
profile=${DEMO_MINIKUBE_PROFILE:-gearbox-demo}
context=${DEMO_KUBE_CONTEXT:-gearbox-demo}
: "${KUBECONFIG:?Set the private demo KUBECONFIG before deploying.}"
helm=$(sh "$script_dir/ensure-helm.sh")
for image in gbx-demo-gateway:0.1.0 gbx-demo-settings-worker:0.1.0 node:24.21.0-alpine postgres:17-bookworm; do
  docker image inspect "$image" >/dev/null
done
# A local image tag can be rebuilt. Record actual content so Helm rolls pods
# when prepared images change, while a repeated identical Deploy stays stable.
: > "$work/images.values.yaml"
for app in demo-gateway demo-settings-worker; do
  image_id=$(docker image inspect --format '{{.Id}}' "gbx-$app:0.1.0")
  printf '%s\n' "$image_id" | grep -Eq '^sha256:[0-9a-f]{64}$' || exit 1
  printf '%s:\n  podAnnotations:\n    demo.gearbox.dev/image-id: "%s"\n' "$app" "$image_id" >> "$work/images.values.yaml"
done
sh "$script_dir/provision-cluster-storage.sh"
sh "$script_dir/verify-chart.sh"
for image in gbx-demo-gateway:0.1.0 gbx-demo-settings-worker:0.1.0 node:24.21.0-alpine postgres:17-bookworm; do
  echo "Loading prepared image: $image"
  minikube -p "$profile" image load --daemon --overwrite "$image"
done
echo 'Applying the prepared product and waiting for readiness.'
"$helm" upgrade --install settings-community-demo "$work/minikube/helm/settings-community-demo" \
  --kubeconfig "$KUBECONFIG" --kube-context "$context" --namespace gearbox-demo \
  -f "$script_dir/../deploy/values.yaml" -f "$work/private/values.private.json" -f "$work/images.values.yaml" \
  --wait --timeout 10m --history-max 10
echo 'Prepared backend product is ready.'
