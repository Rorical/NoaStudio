# com.noa.sine

8-voice polyphonic sine generator. Replaces the Phase 1 hard-coded
`SineGenerator` class with a real WASM plugin loaded through the Noa
plugin ABI v1.

**Params:**
- `Volume` (0..1, default 0.5) — master output level before the global -6 dB trim
- `Octave` (-2..2 integer, default 0) — transposes every NoteOn by 12 semitones per step

**Build:** see `scripts/build-plugins.sh`. The compiled `plugin.wasm`
is committed so CI doesn't need AssemblyScript.

**State format:** 8 bytes — `Volume f32`, `Octave f32`, little-endian.
