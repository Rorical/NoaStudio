# com.noa.gain

Linear gain insert. Multiplies every input sample by `Gain`.

**Params:**
- `Gain` (0..4, default 1, displayed in dB) — output multiplier

**Build:** see `scripts/build-plugins.sh`. The compiled `plugin.wasm`
is committed so CI doesn't need AssemblyScript.

**State format:** 4 bytes — `Gain f32`, little-endian.
