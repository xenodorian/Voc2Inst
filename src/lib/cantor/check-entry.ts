import { analyzeVocal, smoothContour, trackPitch } from "./analyze.ts";
import { arrange } from "./arrange.ts";
import { makeDemoVocal } from "./demo.ts";
import { MAJOR_STEPS, pitchClass } from "./theory.ts";

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function stdev(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export async function run() {
  const problems: string[] = [];
  const sampleRate = 8000;
  const sine = new Float32Array(sampleRate * 2);
  for (let i = 0; i < sine.length; i++) {
    sine[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  const raw = await trackPitch(sine, sampleRate);
  const voiced = raw.filter((frame) => frame.midi != null).map((frame) => frame.midi as number);
  const sineMedian = voiced.length ? median(voiced) : -1;
  if (Math.abs(sineMedian - 69) > 0.35) {
    problems.push(`sine median ${sineMedian} voiced ${voiced.length}/${raw.length}`);
  }

  const vib = new Float32Array(sampleRate * 2);
  let phase = 0;
  for (let i = 1; i < vib.length; i++) {
    const t = i / sampleRate;
    const hz = 440 * 2 ** ((Math.sin(2 * Math.PI * 5.5 * t) * 0.55) / 12);
    phase += (2 * Math.PI * hz) / sampleRate;
    vib[i] = 0.45 * Math.sin(phase);
  }
  const vibSmooth = smoothContour(await trackPitch(vib, sampleRate))
    .map((frame) => frame.midi)
    .filter((midi): midi is number => midi != null);
  const vibMedian = vibSmooth.length ? median(vibSmooth) : -1;
  const vibSd = vibSmooth.length ? stdev(vibSmooth) : 99;
  if (Math.abs(vibMedian - 69) > 0.25) problems.push(`vibrato median ${vibMedian.toFixed(3)}`);
  if (vibSd > 0.2) problems.push(`vibrato stdev ${vibSd.toFixed(3)}`);

  const demo = makeDemoVocal(44100);
  const features = await analyzeVocal(demo, 44100);
  const arrangement = arrange(features, { bpm: null, root: null, mode: null, meter: 4, style: "piano" });
  const scale = new Set(MAJOR_STEPS);
  for (const note of arrangement.notes) {
    if (!scale.has(pitchClass(note.midi))) problems.push(`off-scale midi ${note.midi}`);
  }
  if (features.detectedBpm < 90 || features.detectedBpm > 102) problems.push(`bpm ${features.detectedBpm}`);
  if (arrangement.keyLabel !== "C major") {
    problems.push(`key ${arrangement.keyLabel} score ${features.keyScore.toFixed(3)}`);
  }
  const symbols = arrangement.chords.map((chord) => chord.symbol).join(" ");
  if (symbols !== "C F G C") problems.push(`chords ${symbols}`);
  if (arrangement.downbeat > 0.2) problems.push(`downbeat ${arrangement.downbeat}`);

  const leaps: number[] = [];
  for (let i = 1; i < arrangement.chords.length; i++) {
    const prev = arrangement.chords[i - 1].voicing;
    const next = arrangement.chords[i].voicing;
    for (let voice = 0; voice < 4; voice++) leaps.push(Math.abs(prev[voice] - next[voice]));
  }
  const leapAvg = leaps.reduce((sum, leap) => sum + leap, 0) / leaps.length;
  if (leapAvg > 5) problems.push(`leap avg ${leapAvg.toFixed(2)}`);
  if (Math.max(...leaps) > 12) problems.push(`leap max ${Math.max(...leaps)}`);

  const line = arrange(features, { bpm: null, root: null, mode: null, meter: 4, style: "line" });
  for (const note of line.notes) {
    if (!scale.has(pitchClass(note.midi))) problems.push(`line off-scale ${note.midi}`);
  }
  if (line.notes.length < 8) problems.push(`line notes ${line.notes.length}`);

  return {
    ok: problems.length === 0,
    problems,
    bpm: features.detectedBpm,
    key: arrangement.keyLabel,
    chords: symbols,
    leapAvg: Number(leapAvg.toFixed(2)),
    sineMedian: Number(sineMedian.toFixed(3)),
    vibratoMedian: Number(vibMedian.toFixed(3)),
    vibratoSd: Number(vibSd.toFixed(3)),
    lineNotes: line.notes.length,
  };
}
