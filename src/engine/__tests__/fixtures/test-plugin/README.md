# Test fixture plugin

Not a real plugin. Implements every required ABI v1 export with the
simplest possible logic (passthrough multiplied by a single `Volume`
parameter) so unit tests can drive the host's plugin runner end-to-end
without depending on a real built-in plugin.

Rebuild after editing `src/index.ts`:

```
./scripts/build-plugins.sh
```

The built `plugin.wasm` is committed so CI doesn't need AssemblyScript.
