#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# Prepared image references and fingerprints are owned by the bounded runner.
# Deploy never builds, re-resolves, rotates credentials or deletes data.
exec node "$script_dir/demo.cjs" deploy "$@"
