#!/usr/bin/env bash
# Build every Noa plugin in the repo (test fixtures + built-in plugins).
# Run from anywhere; resolves paths relative to repo root.
#
# Built-in plugins output `<folder>.wasm` (e.g. sine.wasm). Test fixtures
# keep `plugin.wasm` since they're loaded directly via fs.readFile and
# never go through Vite's bundler — which dedupes asset emissions by
# basename and only emits one of N identically-named .wasm files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGINS=(
  "$ROOT/src/engine/__tests__/fixtures/test-plugin"
  "$ROOT/src/engine/__tests__/fixtures/gen-test"
  "$ROOT/src/engine/__tests__/fixtures/preset-test"
  "$ROOT/src/builtin-plugins/sine"
  "$ROOT/src/builtin-plugins/gain"
)

for dir in "${PLUGINS[@]}"; do
  if [ ! -f "$dir/asconfig.json" ]; then continue; fi
  if [[ "$dir" == */builtin-plugins/* ]]; then
    out_name="$(basename "$dir").wasm"
  else
    out_name="plugin.wasm"
  fi
  echo "Building $dir → $out_name"
  (cd "$dir" && npx --prefix "$ROOT" asc src/index.ts -o "$out_name" --runtime stub --optimize --bindings raw)
  # We load the .wasm directly via WebAssembly.compile — discard asc's JS/TS bindings.
  stem="${out_name%.wasm}"
  rm -f "$dir/${stem}.js" "$dir/${stem}.d.ts"
done
