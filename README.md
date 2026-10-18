# Voc2Inst

Cantor — a browser studio that turns a lone vocal into a diatonic instrumental bed.

Live page: [xenodorian.github.io/Voc2Inst](https://xenodorian.github.io/Voc2Inst/)

Drop a WAV or MP3 (or sound the built-in demo phrase). The take is analyzed for pulse, key, and a smoothed pitch contour. One chord is chosen per bar, then voiced as a pad, piano, arpeggio, or counterline. Play it back against the vocal and export a stereo WAV.

The single-file studio is [Voc2Inst.html](Voc2Inst.html). GitHub Pages serves that same file as [index.html](index.html).

## Stack

## Stack

TanStack Start, React 19, Tailwind 4, Web Audio. Pitch tracking, tempo, and voice-leading all run in the browser. No account and no server-side audio.

## Scripts

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

Arrangement checks live in `scripts/cantor-check.mts`.

Work log and remaining steps: [Current_Work.md](Current_Work.md).
