#!/usr/bin/env bash
# Build every Noa plugin in the repo (test fixtures + built-in plugins).
# Reads asconfig.json per plugin; outputs plugin.wasm next to it.
# Run from anywhere; resolves paths relative to repo root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGINS=(
  "$ROOT/src/engine/__tests__/fixtures/test-plugin"
  "$ROOT/src/builtin-plugins/sine"
  "$ROOT/src/builtin-plugins/gain"
)

for dir in "${PLUGINS[@]}"; do
  if [ -f "$dir/asconfig.json" ]; then
    echo "Building $dir"
    (cd "$dir" && npx --prefix "$ROOT" asc src/index.ts -o plugin.wasm --runtime stub --optimize --bindings raw)
    # We load the .wasm directly via WebAssembly.compile — discard asc's JS/TS bindings.
    rm -f "$dir/plugin.js" "$dir/plugin.d.ts"
  fi
done
