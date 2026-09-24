#!/usr/bin/env bash
set -euo pipefail

APP="${1:?usage: precompile_application_python.sh Yulu.app}"
RUNTIME="$APP/Contents/Resources/runtime"
[[ -x "$RUNTIME/python/bin/python3" && -d "$RUNTIME/python/lib" && -d "$RUNTIME/yulu/scripts" ]] || {
  echo "Application Python runtime is incomplete" >&2
  exit 1
}

# Generate bytecode before signing. Runtime -B keeps the App immutable, but
# still reads these caches. Hash invalidation survives staging/copy timestamps;
# the signed resource seal, rather than mtime, protects this immutable code.
# Strip the build machine's path from tracebacks and code objects.
"$RUNTIME/python/bin/python3" -I -B -m compileall -q \
  --invalidation-mode unchecked-hash -s "$RUNTIME" -p /Yulu/runtime \
  "$RUNTIME/python/lib" "$RUNTIME/yulu/scripts"
