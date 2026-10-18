#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
work=${DEMO_WORK_DIR:-$repo/.gearbox/settings-community-demo}
helm=$(sh "$script_dir/ensure-helm.sh")
chart="$work/minikube/helm/settings-community-demo"
render() { "$helm" template settings-community-demo "$chart" --namespace gearbox-demo -f "$script_dir/../deploy/values.yaml" "$@"; }
render > "$work/rendered.yaml"
for change in \
  'demo-gateway.homeVolume.type=emptyDir' \
  'demo-gateway.replicaCount=2' \
  'demo-gateway.strategy.type=RollingUpdate' \
  'demo-gateway.homeVolume.claimName='; do
  if render --set "$change" >/dev/null 2> "$work/rejected-values.log"; then
    echo "Unsafe SQLite deployment was accepted: $change" >&2; exit 1
  fi
done
echo 'Helm rendering passes; ephemeral storage, multiple writers, rolling updates and an empty claim are rejected.'
