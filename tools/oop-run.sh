#!/bin/sh
# Milestone 6, observed rather than asserted: a generated host process starts a
# generated worker process, and a declared contract binding resolves as *remote*
# through the directory.
#
# The evidence is `readiness: dependency resolved`, and the choice of that line
# is deliberate. `host_runtime` marks a dependency resolved immediately when the
# implementation is local, and immediately again when a static endpoint override
# stands in for discovery; only a binding that must be looked up in the directory
# is put on the background probe list this line is emitted from. So the line
# cannot appear for a co-located gear, which is exactly what makes it proof.
# The `wired consumer contract` record the acceptance step names says the same
# thing at DEBUG, and DEBUG is unreachable here: the runtime builds its filter
# from the configuration's `logging` targets, and `RUST_LOG` only caps it.
#
# No database and no Docker. The demo product resolves no cluster primitive, so
# nothing needs Postgres; the directory is an in-memory map inside the host.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CORPUS=${CORPUS:-$ROOT/../gears-rust}
TREE=$ROOT/.gearbox/payments-demo/local
LOG=${LOG:-/tmp/gearbox-oop-run.log}
WORKER_PORT=8090
HOST_PORT=8087

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "  ok   $*"; }

cleanup() {
    # The host stops the worker itself; killing it first would leave an orphan
    # holding the port and make the next run fail for the wrong reason.
    pkill -f gbx-gateway 2>/dev/null || true
    sleep 3
    pkill -f gbx-api-contracts 2>/dev/null || true
}
trap cleanup EXIT INT TERM

[ -d "$CORPUS/gears" ] || fail "no gear corpus at $CORPUS (set CORPUS=)"
for port in $HOST_PORT $WORKER_PORT 50051; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        fail "port $port is already in use; the run needs $HOST_PORT, $WORKER_PORT and 50051"
    fi
done

echo "generating..."
cargo run -q -p gearbox-cli -- generate \
    --root "$CORPUS" --product "$ROOT/products/payments-demo/product.gdl" --profile local >/dev/null

echo "building both binaries (first run takes minutes)..."
( cd "$TREE" && cargo build -q )

# Where the configuration says the worker is, is where the build must have put
# it. This is the invariant a whole class of "the host silently spawned nothing"
# failures comes down to, so it is checked before anything is started.
# Both spellings: the serializer folds a long value onto the next line as `>-`.
# An earlier version of this stripped punctuation to normalise the two, which
# also stripped the hyphens out of the path -- the variable came out empty, and
# `-x` on the tree directory is true, so the check passed on every run including
# a deliberately broken one. Read the value, do not launder it.
EXE=$(awk '
    /executable_path:/ {
        sub(/^[[:space:]]*executable_path:[[:space:]]*/, "")
        if ($0 == ">-" || $0 == ">" || $0 == "") { folded = 1; next }
        print; exit
    }
    folded { sub(/^[[:space:]]+/, ""); print; exit }
' "$TREE/config/gateway.yaml")
[ -n "$EXE" ] || fail "no executable_path in the generated host configuration"
[ -f "$TREE/$EXE" ] || fail "the host is configured to start '$EXE', which the build did not produce"
ok "the configured worker binary exists ($EXE)"

echo "running..."
cleanup
( cd "$TREE" && ../../../../gears-rust/target/debug/gbx-gateway --config config/gateway.yaml ) >"$LOG" 2>&1 &

# The host does not notice a child that dies, so waiting on a condition without
# also watching the host is how this hangs for sixty seconds and says nothing.
waited=0
until curl -sf "127.0.0.1:$WORKER_PORT/readyz" >/dev/null 2>&1; do
    pgrep -f gbx-gateway >/dev/null || fail "the host exited before the worker came up; see $LOG"
    waited=$((waited + 1))
    [ "$waited" -lt 60 ] || fail "the worker did not become ready in 60s; see $LOG"
    sleep 1
done

pgrep -f gbx-api-contracts >/dev/null || fail "nothing is running as the worker"
ok "the host started the worker"
ok "the worker serves its own probes (/readyz)"

# Polled, not grepped once. The worker being ready and the host having noticed
# are different events: the directory resolver memoises a hit for 1500ms and the
# host re-probes on a backoff, so a single grep here fails for timing rather than
# for substance -- which it did, the first time this script ran.
waited=0
until grep -q "readiness: dependency resolved dep=api-contracts" "$LOG"; do
    pgrep -f gbx-gateway >/dev/null || fail "the host exited while resolving; see $LOG"
    waited=$((waited + 1))
    [ "$waited" -lt 60 ] || fail "the binding never resolved through the directory; see $LOG"
    sleep 1
done
ok "the contract binding resolved as remote, through the directory"

curl -sf "127.0.0.1:$HOST_PORT/readyz" >/dev/null || fail "the host is not ready"
ok "the host is ready, so its remote dependency gate opened"

echo "M6: observed."
