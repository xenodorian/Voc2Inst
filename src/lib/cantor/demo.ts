import { midiToHz } from "./theory.ts";

/** A four-bar phrase in C major at 96 bpm, with vibrato and consonant bursts. */
export function makeDemoVocal(sampleRate = 44100): Float32Array {
  const bpm = 96;
  const beat = 60 / bpm;
  const phrase: Array<[number, number]> = [
    [60, 1],
    [64, 1],
    [67, 1],
    [64, 1],
    [65, 1],
    [69, 1],
    [72, 1],
    [69, 1],
    [67, 1],
    [71, 1],
    [74, 1],
    [71, 1],
    [60, 1],
    [64, 1],
    [62, 1],
    [60, 1],
  ];
  const beats = phrase.reduce((sum, note) => sum + note[1], 0);
  const out = new Float32Array(Math.ceil((beats * beat + 0.35) * sampleRate));
  let t = 0;
  let index = 0;
  for (const [midi, length] of phrase) {
    const dur = length * beat;
    const downbeat = index % 4 === 0;
    sing(out, sampleRate, t, dur * 0.88, midi, downbeat ? 1 : 0.58);
    t += dur;
    index += length;
  }
  return out;
}

function noise(i: number): number {
  const x = (Math.imul(i, 1103515245) + 12345) & 0x7fffffff;
  return (x % 10000) / 5000 - 1;
}

function sing(
  out: Float32Array,
  sampleRate: number,
  start: number,
  dur: number,
  midi: number,
  accent: number,
) {
  const f0 = midiToHz(midi);
  const a0 = Math.max(0, Math.floor(start * sampleRate));
  const a1 = Math.min(out.length, Math.floor((start + dur) * sampleRate));
  const amps = [1, 0.52, 0.26, 0.13, 0.06, 0.035];
  let phase = 0;
  let prevT = 0;
  for (let i = a0; i < a1; i++) {
    const t = i / sampleRate - start;
    const dt = t - prevT;
    prevT = t;
    const vib = t > 0.045 ? Math.sin(2 * Math.PI * 5.4 * t) * 0.42 : 0;
    const hz = f0 * 2 ** (vib / 12);
    phase += 2 * Math.PI * hz * dt;
    let s = 0;
    for (let h = 0; h < amps.length; h++) s += amps[h] * Math.sin(phase * (h + 1));
    const attack = Math.min(1, t / 0.02);
    const release = Math.min(1, Math.max(0, (dur - t) / 0.045));
    const env = Math.min(attack, release);
    let burst = 0;
    const burstLen = accent > 0.8 ? 0.018 : 0.01;
    if (t < burstLen) burst = noise(i) * (1 - t / burstLen) * (accent > 0.8 ? 0.7 : 0.28);
    out[i] += (s / 2.05) * env * 0.36 * accent + burst;
  }
}
