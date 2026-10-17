# Current work

Recorded 2026-10-17. First publish of the studio to [xenodorian/Voc2Inst](https://github.com/xenodorian/Voc2Inst) `main`.

The product in the UI is **Cantor**. The repository name is Voc2Inst (vocal → instrument). The name was not changed this pass.

## Done

- Vocal ingest: drag-and-drop or file picker for WAV, MP3, and other browser-decodable audio. A generated demo phrase in C is available before any file is loaded.
- Analysis (`src/lib/cantor/analyze.ts`): mix to mono, peak normalize, downsample, YIN pitch tracking, median smoothing so vibrato does not move the harmony, spectral-flux onsets, tempo and first-beat estimate, Krumhansl-style major/minor key.
- Arrangement (`src/lib/cantor/arrange.ts`, `theory.ts`): eighth-note grid locked to the detected (or overridden) tempo, downbeat, and meter. One diatonic triad per bar. Passing tones do not vote. Voice-leading keeps chord motion small. Styles: pad, piano, arpeggio, counterline a third below.
- Playback and mix (`src/lib/cantor/synth.ts`, `src/components/studio.tsx`): Web Audio bed under the original vocal, bed level, space to play/pause, tempo 60–180, key override, 3/4 and 4/4, reset to the detected grid.
- Export: stereo WAV of vocal plus bed. Renders are capped at the first six minutes.
- Score (`src/components/score-canvas.tsx`): waveform, pitch line, and brass chord blocks with a playhead.
- Studio checks (`src/lib/cantor/check-entry.ts`, `scripts/cantor-check.mts`): A440 tracking, vibrato smoothing, demo phrase lands on C major with chords C–F–G–C, scale lock, and bounded voice-leading.
- Preview smoke of the empty staff (desktop and mobile) showed visible copy, a canvas, and a clean console. Auth and database stay off; nothing is uploaded.

## This pass

- Inventoried the studio already in the workspace. Did not redesign the analysis, the UI, or the product name.
- Added this file, a short README, and a `.gitignore`.
- Pushed the project source to `main`. `node_modules`, sandbox logs, and platform skill files are not in the repo.

## Not done

- [ ] Record from the microphone. Ingest is file upload or the synthetic demo only.
- [ ] Seek by clicking or dragging the staff. Playback only starts from the current playhead or the top.
- [ ] Export MIDI for the bed. Notes exist as timed MIDI events but only leave the app as audio.
- [ ] Download the bed and the vocal as separate stems.
- [ ] Render past six minutes, or show progress for long offline renders.
- [ ] Modes other than major and minor (Dorian, Mixolydian, harmonic minor).
- [ ] Meters other than 3/4 and 4/4.
- [ ] Edit a single bar's chord without recomputing the whole grid.
- [ ] Replace oscillator patches with sampled piano, pad, and bass.
- [ ] Remember the last take's tempo, key, style, and bed level between visits.
- [ ] Run `scripts/cantor-check.mts` from `npm test` so the arrangement checks are part of the default suite.
- [ ] Decide whether the visible name stays Cantor or becomes Voc2Inst.
