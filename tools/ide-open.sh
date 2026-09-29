#!/bin/sh
# Opens the Studio URL in a browser once the server actually answers, rather
# than the instant it is launched -- which would just be a connection-refused
# page, since the frontend build and `theia start` both take a while.
#
# Backgrounded by the Makefile (`ide`, `ide-release`) alongside the real,
# foreground `npm run start:browser`. If that build or start fails, this loop
# just gives up after its own timeout with nothing to show; the actual error
# is on the foreground command's output, not here.
set -eu

URL=$1
waited=0
until curl -sf -o /dev/null "$URL" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -lt 180 ] || exit 0
    sleep 1
done

if command -v open >/dev/null 2>&1; then
    open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
else
    echo "Studio is up: $URL"
fi
