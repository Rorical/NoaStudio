# preset-test fixture

ABI v1.1 test plugin. Implements all four optional preset exports
(`noa_preset_prepare`, `noa_preset_get_state_size`,
`noa_preset_serialize`, `noa_preset_free`) plus the standard v1.0
surface so PluginInstance + PluginWorker tests can exercise the
prepare/serialize/free path against a real WASM module.

Preset format: 12 bytes — `'NTP1'` magic (4B) + A `f32` + B `f32`.
The plugin stores up to 4 prepared presets in a fixed array; the
returned handle is the 1-based slot index.

Rebuild via `./scripts/build-plugins.sh`.
