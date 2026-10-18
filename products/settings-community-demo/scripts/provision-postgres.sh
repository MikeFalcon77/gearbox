#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
work=${DEMO_WORK_DIR:-$repo/.gearbox/settings-community-demo}
container=gearbox-demo-postgres
volume=gearbox-demo-postgres-data
owner=settings-community-demo
image=${DEMO_POSTGRES_IMAGE:-postgres:17-bookworm}
network=${DEMO_MINIKUBE_PROFILE:-gearbox-demo}
docker network inspect "$network" >/dev/null

test -f "$work/private/postgres.env" || {
  echo 'Run prepare-inputs.cjs before provisioning Postgres.' >&2; exit 1;
}
if docker volume inspect "$volume" >/dev/null 2>&1; then
  actual_owner=$(docker volume inspect --format '{{ index .Labels "app.kubernetes.io/part-of" }}' "$volume")
  test "$actual_owner" = "$owner" || { echo 'Refusing an unowned Postgres volume.' >&2; exit 1; }
else
  docker volume create --label "app.kubernetes.io/part-of=$owner" "$volume" >/dev/null
fi
if docker container inspect "$container" >/dev/null 2>&1; then
  actual_owner=$(docker container inspect --format '{{ index .Config.Labels "app.kubernetes.io/part-of" }}' "$container")
  actual_mount=$(docker container inspect --format '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Name }}{{ end }}{{ end }}' "$container")
  test "$actual_owner" = "$owner" && test "$actual_mount" = "$volume" || {
    echo 'Refusing an existing container with different ownership or storage.' >&2; exit 1;
  }
  docker start "$container" >/dev/null
else
  docker image inspect "$image" >/dev/null
  docker run --pull never -d --name "$container" --restart unless-stopped \
    --label "app.kubernetes.io/part-of=$owner" \
    --env-file "$work/private/postgres.env" \
    --network "$network" \
    --publish "127.0.0.1:55432:5432" \
    --mount "type=volume,source=$volume,target=/var/lib/postgresql/data" \
    "$image" >/dev/null
fi
network_id=$(docker network inspect --format '{{.Id}}' "$network")
container_network_id=$(docker container inspect --format "{{ with index .NetworkSettings.Networks \"$network\" }}{{ .NetworkID }}{{ end }}" "$container")
test "$container_network_id" = "$network_id" || { echo 'Postgres must join the private demo Docker network.' >&2; exit 1; }
ports=$(docker container inspect --format '{{ json .HostConfig.PortBindings }}' "$container")
test "$ports" = '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55432"}]}' || {
  echo 'Postgres must expose only its loopback operator port.' >&2; exit 1;
}
attempt=0
until docker exec "$container" pg_isready -U gearbox_demo -d postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 60 || { echo 'Postgres did not become ready.' >&2; exit 1; }
  sleep 1
done
for database in credstore settings_service types_registry gearbox_demo_cluster; do
  docker exec -i "$container" psql -U gearbox_demo -d postgres \
    --set=ON_ERROR_STOP=1 --set="demo_database=$database" < "$script_dir/../deploy/init-database.sql"
done
postgres_ip=$(docker container inspect --format "{{ with index .NetworkSettings.Networks \"$network\" }}{{ .IPAddress }}{{ end }}" "$container")
case "$postgres_ip" in
  ''|*[!0-9.]*) echo 'Expected an IPv4 address on the private demo bridge.' >&2; exit 1 ;;
esac
cat > "$work/private/external-postgres.yaml" <<EOF
apiVersion: v1
kind: Service
metadata:
  name: external-postgres
  namespace: gearbox-demo
  labels:
    app.kubernetes.io/part-of: settings-community-demo
spec:
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: external-postgres-demo
  namespace: gearbox-demo
  labels:
    kubernetes.io/service-name: external-postgres
    endpointslice.kubernetes.io/managed-by: gearbox-demo
    app.kubernetes.io/part-of: settings-community-demo
addressType: IPv4
ports:
  - name: postgres
    protocol: TCP
    port: 5432
endpoints:
  - addresses: ["$postgres_ip"]
    conditions:
      ready: true
EOF
echo 'External demo Postgres is ready on the private minikube Docker bridge with a persistent data volume.'
echo 'Operator access is bound to 127.0.0.1:55432; Kubernetes uses the private external-postgres endpoint.'
