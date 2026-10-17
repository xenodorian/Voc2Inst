export type Mode = "major" | "minor";

export const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

/** Krumhansl–Kessler probe-tone profiles, tonic at index 0. */
export const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export type Quality = "maj" | "min" | "dim";

export type Triad = {
  rootPc: number;
  third: number;
  fifth: number;
  quality: Quality;
  degree: string;
  degreeIndex: number;
  /** Raised leading-tone dominant in minor — a safe modal variant, not a new key. */
  altered: boolean;
};

export function stepsFor(mode: Mode): number[] {
  return mode === "major" ? MAJOR_STEPS : MINOR_STEPS;
}

export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function keyName(root: number, mode: Mode): string {
  return `${NOTE_NAMES[root]} ${mode}`;
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function buildScale(root: number, mode: Mode, low = 36, high = 84): number[] {
  const steps = stepsFor(mode);
  const tones: number[] = [];
  for (let m = low; m <= high; m++) {
    if (steps.includes((pitchClass(m) - root + 12) % 12)) tones.push(m);
  }
  return tones;
}

export function nearestScaleTone(midi: number, scale: number[]): number {
  let best = scale[0] ?? Math.round(midi);
  let dist = Infinity;
  for (const tone of scale) {
    const d = Math.abs(tone - midi);
    if (d < dist) {
      dist = d;
      best = tone;
    }
  }
  return best;
}

export function inScale(midi: number, root: number, mode: Mode): boolean {
  return stepsFor(mode).includes((pitchClass(midi) - root + 12) % 12);
}

export function diatonicTriads(root: number, mode: Mode): Triad[] {
  const scale = stepsFor(mode);
  const qualities: Quality[] =
    mode === "major"
      ? ["maj", "min", "min", "maj", "maj", "min", "dim"]
      : ["min", "dim", "maj", "min", "min", "maj", "maj"];
  const degrees =
    mode === "major"
      ? ["I", "ii", "iii", "IV", "V", "vi", "vii°"]
      : ["i", "ii°", "III", "iv", "v", "VI", "VII"];

  const triads: Triad[] = scale.map((degree, i) => ({
    rootPc: (root + degree) % 12,
    third: (root + scale[(i + 2) % 7]) % 12,
    fifth: (root + scale[(i + 4) % 7]) % 12,
    quality: qualities[i],
    degree: degrees[i],
    degreeIndex: i,
    altered: false,
  }));

  if (mode === "minor") {
    triads.push({
      rootPc: (root + 7) % 12,
      third: (root + 11) % 12,
      fifth: (root + 2) % 12,
      quality: "maj",
      degree: "V",
      degreeIndex: 4,
      altered: true,
    });
  }
  return triads;
}

export function triadSymbol(triad: Triad): string {
  const name = NOTE_NAMES[triad.rootPc];
  if (triad.quality === "min") return `${name}m`;
  if (triad.quality === "dim") return `${name}dim`;
  return name;
}

export function triadContains(triad: Triad, pc: number): boolean {
  return pc === triad.rootPc || pc === triad.third || pc === triad.fifth;
}

/** Semitone distance on the clock, 0–6. */
export function pcDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}

const MOTION_COST = [0.32, 1.15, 0.22, 0.38, 0.42, 0.08, 0.95];

export function rootMotionCost(from: number, to: number): number {
  return MOTION_COST[pcDistance(from, to)];
}

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
