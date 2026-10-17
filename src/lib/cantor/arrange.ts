import type { Features } from "./analyze.ts";
import { downbeatAt, phaseAtBpm } from "./analyze.ts";
import {
  buildScale,
  clamp,
  diatonicTriads,
  inScale,
  keyName,
  nearestScaleTone,
  pitchClass,
  rootMotionCost,
  triadContains,
  triadSymbol,
  type Mode,
  type Triad,
} from "./theory.ts";

export type StyleId = "pad" | "piano" | "arp" | "line";

export type BedNote = {
  midi: number;
  start: number;
  duration: number;
  gain: number;
  role: "bass" | "chord" | "line";
};

export type GridCell = {
  start: number;
  duration: number;
  /** Scale-snapped MIDI, or null for a rest. */
  midi: number | null;
  /** Median heard pitch before the scale snap. */
  heard: number | null;
  diatonic: boolean;
  passing: boolean;
  voiced: boolean;
};

export type ChordMark = {
  symbol: string;
  degree: string;
  start: number;
  duration: number;
  /** [bass, low, mid, high] */
  voicing: number[];
};

export type Arrangement = {
  bpm: number;
  meter: 3 | 4;
  root: number;
  mode: Mode;
  keyLabel: string;
  downbeat: number;
  cells: GridCell[];
  chords: ChordMark[];
  notes: BedNote[];
};

export type ArrangeOpts = {
  bpm: number | null;
  root: number | null;
  mode: Mode | null;
  meter: 3 | 4;
  style: StyleId;
};

function median(values: number[]): number {
  const a = values.slice().sort((x, y) => x - y);
  const mid = a.length >> 1;
  if (a.length % 2 === 1) return a[mid];
  return (a[mid - 1] + a[mid]) / 2;
}

function eighthWeight(index: number, meter: 3 | 4): number {
  const off = index % 2 === 1;
  if (off) return 0.38;
  const beat = Math.floor(index / 2);
  if (beat === 0) return 4;
  if (meter === 4 && beat === 2) return 2.15;
  if (meter === 3 && beat === 2) return 1.25;
  return 1;
}

function buildCells(
  features: Features,
  bpm: number,
  downbeat: number,
  root: number,
  mode: Mode,
): GridCell[] {
  const eighth = 60 / bpm / 2;
  const scale = buildScale(root, mode);
  const frames = features.frames;
  let t = downbeat;
  while (t > 0.0001) t -= eighth;
  const cells: GridCell[] = [];
  let fi = 0;
  for (; t < features.duration - eighth * 0.2; t += eighth) {
    const t0 = t;
    const t1 = t + eighth;
    const overlap = Math.min(t1, features.duration) - Math.max(t0, 0);
    if (overlap < eighth * 0.4) continue;
    while (fi < frames.length && frames[fi].t < t0) fi++;
    const values: number[] = [];
    let total = 0;
    for (let k = fi; k < frames.length && frames[k].t < t1; k++) {
      total++;
      const m = frames[k].midi;
      if (m != null) values.push(m);
    }
    const voiced = total > 0 && values.length / total >= 0.34 && values.length >= 2;
    if (!voiced) {
      cells.push({
        start: t0,
        duration: eighth,
        midi: null,
        heard: null,
        diatonic: false,
        passing: false,
        voiced: false,
      });
      continue;
    }
    const heard = median(values);
    const rounded = Math.round(heard);
    const diatonic = inScale(rounded, root, mode);
    const snapped = diatonic ? rounded : nearestScaleTone(heard, scale);
    cells.push({
      start: t0,
      duration: eighth,
      midi: snapped,
      heard,
      diatonic,
      passing: false,
      voiced: true,
    });
  }

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!cell.voiced || cell.midi == null || !cell.diatonic) continue;
    const prev = cells[i - 1];
    const next = cells[i + 1];
    const index = Math.round((cell.start - downbeat) / eighth);
    const off = ((index % 2) + 2) % 2 === 1;
    if (
      off &&
      prev?.midi != null &&
      next?.midi != null &&
      Math.abs(prev.midi - cell.midi) >= 1 &&
      Math.abs(next.midi - cell.midi) >= 1
    ) {
      cell.passing = true;
    }
  }
  return cells;
}

function placeUppers(triad: Triad, center: number): number[][] {
  const r = triad.rootPc;
  const third = r + ((triad.third - r + 12) % 12);
  const fifth = third + ((triad.fifth - triad.third + 12) % 12);
  const shapes = [
    [r, third, fifth],
    [third, fifth, r + 12],
    [fifth, r + 12, third + 12],
  ];
  const out: number[][] = [];
  for (const shape of shapes) {
    const avg = (shape[0] + shape[1] + shape[2]) / 3;
    const shift = Math.round((center - avg) / 12) * 12;
    for (const oct of [-12, 0, 12]) {
      const voiced = shape.map((n) => n + shift + oct);
      if (voiced.every((n) => n >= 52 && n <= 79)) out.push(voiced);
    }
  }
  if (out.length === 0) {
    const shape = shapes[0];
    const avg = (shape[0] + shape[1] + shape[2]) / 3;
    const shift = Math.round((64 - avg) / 12) * 12;
    out.push(shape.map((n) => n + shift));
  }
  return out;
}

function voiceCost(next: number[], prev: number[] | null): number {
  if (!prev) return 0;
  let cost = 0;
  for (let i = 0; i < 3; i++) {
    const leap = Math.abs(next[i] - prev[i]);
    cost += leap;
    if (leap > 7) cost += (leap - 7) * 2.4;
  }
  return cost;
}

function chooseBass(rootPc: number, prev: number | null): number {
  const target = prev ?? 43;
  let best = 36 + ((rootPc - 36) % 12) + 36;
  let bestD = Infinity;
  for (let m = 36; m <= 52; m++) {
    if (pitchClass(m) !== rootPc) continue;
    const d = Math.abs(m - target);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

function chooseChord(
  votes: Array<{ pc: number; weight: number }>,
  strongPc: number | null,
  root: number,
  mode: Mode,
  prevRoot: number | null,
): Triad | null {
  const triads = diatonicTriads(root, mode);
  const primary = mode === "major" ? new Set([0, 3, 4, 5]) : new Set([0, 3, 5, 6]);
  let best: Triad | null = null;
  let bestScore = -Infinity;
  for (const triad of triads) {
    let pos = 0;
    let neg = 0;
    for (const vote of votes) {
      if (triadContains(triad, vote.pc)) pos += vote.weight;
      else neg += vote.weight;
    }
    const fit = (pos - 0.4 * neg) / (pos + neg || 1);
    let score = fit * 3.15;
    if (primary.has(triad.degreeIndex) && !triad.altered) score += 0.16;
    if (triad.quality === "dim") score -= 0.95;
    if (strongPc != null && strongPc === triad.rootPc) score += 0.64;
    else if (strongPc != null && triadContains(triad, strongPc)) score += 0.16;
    if (prevRoot != null) score -= rootMotionCost(prevRoot, triad.rootPc);
    if (score > bestScore) {
      bestScore = score;
      best = triad;
    }
  }
  return best;
}

function scaleIndex(scale: number[], midi: number): number {
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < scale.length; i++) {
    const d = Math.abs(scale[i] - midi);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

function moveToward(current: number, target: number, scale: number[], maxLeap: number): number {
  if (Math.abs(target - current) <= maxLeap) return target;
  const dir = Math.sign(target - current);
  let best = current;
  let bestDist = Math.abs(current - target);
  for (const tone of scale) {
    const delta = tone - current;
    if (Math.sign(delta) !== dir || Math.abs(delta) > maxLeap) continue;
    const dist = Math.abs(tone - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = tone;
    }
  }
  return best;
}

function counterTarget(vocal: number, scale: number[]): number {
  const snapped = nearestScaleTone(vocal, scale);
  let idx = scaleIndex(scale, snapped);
  let target = scale[Math.max(0, idx - 2)];
  if (snapped - target < 3) target = scale[Math.max(0, idx - 4)] ?? target;
  idx = scaleIndex(scale, target);
  while (target > snapped - 3 && idx > 0) {
    idx--;
    target = scale[idx];
  }
  while (target < 48) {
    const up = target + 12;
    if (up > snapped - 3) break;
    target = up;
  }
  if (target > snapped - 3 && target - 12 >= 40) target -= 12;
  return clamp(target, 40, 74);
}

function pushPad(notes: BedNote[], voicing: number[], start: number, duration: number) {
  const [bass, ...upper] = voicing;
  notes.push({ midi: bass, start, duration, gain: 0.042, role: "bass" });
  for (const midi of upper) notes.push({ midi, start, duration, gain: 0.034, role: "chord" });
}

function pushPiano(notes: BedNote[], voicing: number[], start: number, duration: number, bpm: number, meter: 3 | 4) {
  const beat = 60 / bpm;
  const [bass, ...upper] = voicing;
  const bassDur = Math.min(duration, beat * (meter === 3 ? 2 : 2));
  notes.push({ midi: bass, start, duration: bassDur, gain: 0.1, role: "bass" });
  const stab = Math.min(beat * 0.95, duration);
  for (const midi of upper) notes.push({ midi, start, duration: stab, gain: 0.072, role: "chord" });
  if (meter === 4 && duration > beat * 2.2) {
    const echo = start + beat * 2;
    for (const midi of upper) {
      notes.push({ midi, start: echo, duration: Math.min(stab, start + duration - echo), gain: 0.05, role: "chord" });
    }
  }
}

function pushArp(
  notes: BedNote[],
  voicing: number[],
  start: number,
  duration: number,
  bpm: number,
  meter: 3 | 4,
  rising: boolean,
) {
  const eighth = 60 / bpm / 2;
  const steps = meter * 2;
  const pattern = rising ? [0, 1, 2, 3, 2, 1, 2, 3] : [0, 3, 2, 1, 2, 3, 2, 1];
  for (let s = 0; s < steps; s++) {
    const at = start + s * eighth;
    if (at >= start + duration - 0.02) break;
    const idx = pattern[s % pattern.length];
    notes.push({
      midi: voicing[idx],
      start: at,
      duration: eighth * 0.88,
      gain: idx === 0 ? 0.085 : 0.06,
      role: idx === 0 ? "bass" : "chord",
    });
  }
}

export function arrange(features: Features, opts: ArrangeOpts): Arrangement {
  const bpm = clamp(Math.round(opts.bpm ?? features.detectedBpm), 60, 180);
  const root = opts.root ?? features.detectedRoot;
  const mode = opts.mode ?? features.detectedMode;
  const meter = opts.meter;
  let firstBeat = features.detectedFirstBeat;
  if (opts.bpm != null && Math.round(opts.bpm) !== features.detectedBpm) {
    firstBeat = phaseAtBpm(features.flux, features.fluxHop, bpm);
  }
  const downbeat = downbeatAt(features.flux, features.fluxHop, bpm, firstBeat, meter);
  const cells = buildCells(features, bpm, downbeat, root, mode);
  const barDur = (60 / bpm) * meter;
  const eighth = 60 / bpm / 2;
  const scale = buildScale(root, mode, 40, 81);
  const chords: ChordMark[] = [];
  const notes: BedNote[] = [];

  let prevUpper: number[] | null = null;
  let prevBass: number | null = null;
  let prevRoot: number | null = null;
  let prevMel: number | null = null;
  let prevLine: number | null = null;

  let barStart = downbeat;
  while (barStart > 0.02) barStart -= barDur;

  for (; barStart < features.duration - barDur * 0.28; barStart += barDur) {
    const barEnd = barStart + barDur;
    const inBar = cells.filter((c) => c.start >= barStart - 1e-4 && c.start < barEnd - 1e-4);
    const votes: Array<{ pc: number; weight: number }> = [];
    let strongPc: number | null = null;
    let strongW = -1;
    const heard: number[] = [];
    for (const cell of inBar) {
      if (!cell.voiced || cell.midi == null || !cell.diatonic) continue;
      heard.push(cell.midi);
      const index = Math.round((cell.start - barStart) / eighth);
      let w = eighthWeight(Math.max(0, index), meter);
      if (cell.passing) w *= 0.22;
      const pc = pitchClass(cell.midi);
      votes.push({ pc, weight: w });
      if (w > strongW) {
        strongW = w;
        strongPc = pc;
      }
    }
    const weightSum = votes.reduce((s, v) => s + v.weight, 0);
    const melMedian = heard.length ? median(heard) : null;

    if (opts.style === "line") {
      const quarters = meter;
      const qDur = barDur / quarters;
      for (let q = 0; q < quarters; q++) {
        const q0 = barStart + q * qDur;
        const q1 = q0 + qDur;
        const group = inBar.filter((c) => c.voiced && c.midi != null && c.start >= q0 - 1e-4 && c.start < q1 - 1e-4);
        if (group.length === 0) {
          prevLine = null;
          continue;
        }
        const vocal = median(group.map((c) => c.midi as number));
        let target = counterTarget(vocal, scale);
        if (prevLine != null) target = moveToward(prevLine, target, scale, 5);
        if (vocal - target < 3) continue;
        const at = Math.max(0, q0);
        const dur = Math.min(features.duration, q1) - at;
        if (dur < 0.05) continue;
        notes.push({ midi: target, start: at, duration: dur * 0.94, gain: 0.078, role: "line" });
        prevLine = target;
      }
    }

    if (weightSum < 1.15 || melMedian == null) {
      prevMel = melMedian ?? prevMel;
      continue;
    }

    const triad = chooseChord(votes, strongPc, root, mode, prevRoot);
    if (!triad) continue;

    const dir: number = prevMel == null ? 0 : clamp(melMedian - prevMel, -8, 8);
    const prevAvg: number = prevUpper ? (prevUpper[0] + prevUpper[1] + prevUpper[2]) / 3 : 64;
    const center: number = prevAvg + clamp(dir * 0.45, -5, 5);
    let bass = chooseBass(triad.rootPc, prevBass);
    let bestUpper: number[] | null = null;
    let bestCost = Infinity;
    const candidates: number[][] = placeUppers(triad, center);
    for (const upper of candidates) {
      let cost = voiceCost(upper, prevUpper);
      if (upper[0] < bass + 5) cost += 6;
      const avg = (upper[0] + upper[1] + upper[2]) / 3;
      cost += Math.abs(avg - center) * 0.18;
      if (!prevUpper) cost += Math.abs(avg - 64) * 0.05;
      if (cost < bestCost) {
        bestCost = cost;
        bestUpper = upper;
      }
    }
    if (!bestUpper) continue;
    if (bestUpper[0] < bass + 5 && bass - 12 >= 36) bass -= 12;

    const start = Math.max(0, barStart);
    const end = Math.min(features.duration, barEnd);
    const duration = end - start;
    if (duration < 0.08) continue;
    const voicing = [bass, bestUpper[0], bestUpper[1], bestUpper[2]];
    chords.push({
      symbol: triadSymbol(triad),
      degree: triad.degree,
      start,
      duration,
      voicing,
    });

    if (opts.style === "pad") pushPad(notes, voicing, start, duration);
    else if (opts.style === "piano") pushPiano(notes, voicing, start, duration, bpm, meter);
    else if (opts.style === "arp") {
      const mid = barStart + barDur / 2;
      const early = heard.length ? inBar.filter((c) => c.voiced && c.midi != null && c.start < mid) : [];
      const late = inBar.filter((c) => c.voiced && c.midi != null && c.start >= mid);
      const a = early.length ? median(early.map((c) => c.midi as number)) : melMedian;
      const b = late.length ? median(late.map((c) => c.midi as number)) : melMedian;
      pushArp(notes, voicing, start, duration, bpm, meter, b >= a - 0.3);
    }

    prevUpper = bestUpper;
    prevBass = bass;
    prevRoot = triad.rootPc;
    prevMel = melMedian;
  }

  return {
    bpm,
    meter,
    root,
    mode,
    keyLabel: keyName(root, mode),
    downbeat,
    cells,
    chords,
    notes,
  };
}
