# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Vite dev server on port 5173 (see `vite.config.js`).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` for smoke-testing.

There is no test runner, linter, or type checker configured. Don't claim "tests pass" — there are none. For UI changes, run `npm run dev` and click through.

## Architecture

Noa Studio is a **mock DAW (FL Studio-style) UI**, fully client-side. There is no audio engine, no backend, no persistence. Everything that looks like playback, metering, or signal flow is simulated for visual fidelity.

### State lives in App.jsx

`src/App.jsx` is the single source of truth. It owns `tracks`, `clips`, `channels`, transport state (`playing`, `recording`, `bpm`, `time`), selection, view toggles, and `levels`. All child components are presentational — they receive data + callbacks as props and never own domain state. When adding behavior, mutate state in `App.jsx` and pass a new callback down; don't create local stores or contexts.

Initial state seeds come from `src/data.js` (`DEMO_TRACKS`, `DEMO_CLIPS`, `DEMO_CHANNELS`, `PLUGINS`, `FILES`, `TRACK_COLORS`). Editing `data.js` is the supported way to change the starting project.

### The two-loop time model

Two independent `requestAnimationFrame` loops run in `App.jsx`:

1. **Transport loop** (depends on `playing`, `bpm`, `loop`): advances `time` in **beats** at rate `bpm/60`. Loops at beat 32 when `loop` is on, hard-stops at 128 otherwise.
2. **Meter loop** (always running): writes synthetic `levels[channelId]` and `levels[channelId + '_r']` (L/R) using `sin()`/`Math.random()` keyed off the current beat and channel name. Special-cased names: `Kick`, `Snare`, `Hats`, `Master`. There is **no real audio analysis** — adding/renaming a channel won't make it meter unless it matches these names or you extend the loop.

Time is always in beats internally. The Toolbar converts to bars:beats:ticks and to a wall clock using `bpm`.

### Track ↔ Channel coupling

`track.channel` is an integer; the corresponding mixer strip's id is `'m' + track.channel`. `toggleTrackMute` / `toggleTrackSolo` in `App.jsx` mirror the change onto the channel (via `toggleMute('m' + tr.channel)`). If you add new tracks, keep this convention or the mute/solo from the playlist won't reach the mixer.

Special channel ids: `m0` is Master; ids starting with `mB` are drum buses, `mR` are reverb buses (used for CSS variant styling in `Mixer.jsx`).

### Drag-and-drop wiring

The Browser pane writes a serialized plugin object onto the drag event:
`e.dataTransfer.setData('plugin', JSON.stringify(p))`. Drop targets parse it back:

- **Playlist track header** → `kind === 'gen'` → `onAssignGenerator(trackId, name)` sets the track's generator and forces `type: 'midi'`.
- **Mixer channel strip or FX panel** → `kind === 'fx'` → `onAddEffect(channelId, plugin)` appends an effect with a new random id.

Both endpoints live in their respective components; the data contract is just the `{name, kind, tag}` shape from `PLUGINS`.

### Clip model and the piano roll

Clips are either audio (`clip.audio === true`, rendered as fake `ClipWaveform`) or MIDI (`clip.pattern.notes` rendered as `ClipMidiPreview`). MIDI notes are stored as compact tuples `[beat, pitch, length]` in `data.js` and inside `clip.pattern.notes`. The `PianoRoll` component inflates them to `{id, beat, pitch, length, velocity}` for editing and serializes back to tuples via `onUpdateNotes` on every change.

`PianoRoll` will auto-grow the parent clip's `length` (rounded up to the next bar) when a note is drawn or dragged past the end, via `onUpdateLength` → `updateClipLength` in `App.jsx` (which only grows, never shrinks).

Layout constants are component-local and intentionally hardcoded — `Playlist`: `BEAT_PX = 26`, `BAR_BEATS = 4`, `TOTAL_BEATS = 128`, `TRACK_H = 56`. `PianoRoll`: `PR_BEAT_W = 56`, `PR_KEY_H = 14`, `PR_OCTAVES = 4` (48 keys, ~C3–C7). Changing these cascades through positioning math.

### Styling

Two CSS files imported in `main.jsx`:
- `src/styles/styles.css` — Material 3 design tokens (`--m3-*`) for `[data-theme="dark"]` and `[data-theme="light"]`, plus layout/shell.
- `src/styles/styles-components.css` — per-component styles (toolbar, playlist, mixer, piano roll, browser, etc.).

The theme is switched by `App.jsx` setting `data-theme` on `document.documentElement` (see the `useEffect` on `theme`). Component CSS uses `--track` as a per-instance custom property — components set it inline via `style={{ '--track': color }}` so the same class can be tinted per-track. Preserve that pattern when adding track-aware UI.

`TweaksPanel.jsx` is an exception: it ships its own inline `<style>` block (`TWEAKS_STYLE`) instead of using the global stylesheets. Keep tweak-panel CSS local to that file.

### Icons

`src/components/Icon.jsx` is a flat lookup of inline SVG `<path>`/`<g>` nodes keyed by name. To add an icon, add an entry to the `ICONS` map — don't reach for an icon library.
