import {
  MAJOR_PROFILE,
  MINOR_PROFILE,
  type Mode,
  hzToMidi,
  pearson,
  pitchClass,
} from "./theory.ts";

export type PitchFrame = {
  /** Seconds, at the center of the analysis window. */
  t: number;
  /** Smoothed MIDI pitch, or null when unvoiced. Still carries vibrato-removed intent, not a raw cycle. */
  midi: number | null;
  conf: number;
};

export type WaveBin = { min: number; max: number };

export type Features = {
  duration: number;
  sampleRate: number;
  waveform: WaveBin[];
  frames: PitchFrame[];
  frameHop: number;
  flux: Float32Array;
  fluxHop: number;
  detectedBpm: number;
  /** Time of a beat (not necessarily the downbeat), in seconds. */
  detectedFirstBeat: number;
  detectedRoot: number;
  detectedMode: Mode;
  keyScore: number;
  voicedFraction: number;
};

const PITCH_RATE = 8000;
const MIN_HZ = 75;
const MAX_HZ = 1000;
const YIN_THRESHOLD = 0.16;

export function mixToMono(channels: Float32Array[]): Float32Array {
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  if (channels.length === 0 || n === 0) return out;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const s = ch[i];
      if (Number.isFinite(s)) out[i] += s;
    }
  }
  const inv = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

function normalizePeak(input: Float32Array, peakTarget = 0.85): Float32Array {
  const out = new Float32Array(input.length);
  let peak = 0;
  for (let i = 0; i < input.length; i++) {
    const s = Number.isFinite(input[i]) ? input[i] : 0;
    out[i] = s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  if (peak > 0.0008) {
    const g = peakTarget / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

export function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate - 1) return input;
  const ratio = inRate / outRate;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let s = 0;
    for (let j = a; j < b; j++) s += input[j];
    out[i] = s / (b - a);
  }
  return out;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place radix-2 FFT. Sign is forward (e^{-2πi}). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const uRe = re[a];
        const uIm = im[a];
        const vRe = re[b] * wRe - im[b] * wIm;
        const vIm = re[b] * wIm + im[b] * wRe;
        re[a] = uRe + vRe;
        im[a] = uIm + vIm;
        re[b] = uRe - vRe;
        im[b] = uIm - vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
}

function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

function parabolicOffset(ym1: number, y0: number, yp1: number): number {
  const denom = 2 * (ym1 - 2 * y0 + yp1);
  if (Math.abs(denom) < 1e-12) return 0;
  return Math.max(-1, Math.min(1, (ym1 - yp1) / denom));
}

export type RawPitch = { t: number; midi: number | null; conf: number };

/**
 * YIN via FFT autocorrelation. Heavy enough to be correct, chunked so the UI can breathe.
 * Window is unwindowed on purpose — YIN's difference function assumes a raw frame.
 */
export async function trackPitch(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (ratio: number) => void,
): Promise<RawPitch[]> {
  const ds = downsample(samples, sampleRate, PITCH_RATE);
  const win = 1024;
  const hop = 80;
  const nfft = nextPow2(win * 2);
  const tauMin = Math.max(2, Math.floor(PITCH_RATE / MAX_HZ));
  const tauMax = Math.min(win - 3, Math.floor(PITCH_RATE / MIN_HZ));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const prefix = new Float64Array(win + 1);
  const diff = new Float64Array(tauMax + 1);
  const cmnd = new Float64Array(tauMax + 1);
  const total = Math.max(0, Math.floor((ds.length - win) / hop));
  const frames: RawPitch[] = new Array(total);

  for (let fi = 0; fi < total; fi++) {
    const start = fi * hop;
    let mean = 0;
    for (let i = 0; i < win; i++) mean += ds[start + i];
    mean /= win;

    prefix[0] = 0;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < win; i++) {
      const x = ds[start + i] - mean;
      re[i] = x;
      prefix[i + 1] = prefix[i] + x * x;
    }
    const rms = Math.sqrt(prefix[win] / win);
    const t = (start + win / 2) / PITCH_RATE;

    if (rms < 0.012) {
      frames[fi] = { t, midi: null, conf: 0 };
    } else {
      fft(re, im);
      for (let i = 0; i < nfft; i++) {
        re[i] = re[i] * re[i] + im[i] * im[i];
        im[i] = 0;
      }
      ifft(re, im);

      diff[0] = 0;
      let running = 0;
      for (let tau = 1; tau <= tauMax; tau++) {
        const sum1 = prefix[win - tau];
        const sum2 = prefix[win] - prefix[tau];
        const d = sum1 + sum2 - 2 * re[tau];
        diff[tau] = d > 0 ? d : 0;
        running += diff[tau];
        cmnd[tau] = (diff[tau] * tau) / (running || 1);
      }

      let tauEst = -1;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (cmnd[tau] < YIN_THRESHOLD) {
          while (tau < tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
          tauEst = tau;
          break;
        }
      }
      if (tauEst < 0) {
        let minC = Infinity;
        let minT = tauMin;
        for (let tau = tauMin; tau <= tauMax; tau++) {
          if (cmnd[tau] < minC) {
            minC = cmnd[tau];
            minT = tau;
          }
        }
        tauEst = minC < 0.5 ? minT : -1;
      }

      if (tauEst > tauMin * 2) {
        const half = Math.round(tauEst / 2);
        if (
          half >= tauMin &&
          cmnd[half] < 0.42 &&
          cmnd[half] <= cmnd[Math.max(tauMin, half - 1)] &&
          cmnd[half] <= cmnd[Math.min(tauMax, half + 1)] &&
          cmnd[half] < cmnd[tauEst] + 0.18
        ) {
          tauEst = half;
        }
      }

      if (tauEst < 0) {
        frames[fi] = { t, midi: null, conf: 0 };
      } else {
        const tauF = tauEst + parabolicOffset(diff[tauEst - 1], diff[tauEst], diff[tauEst + 1]);
        const hz = PITCH_RATE / tauF;
        const conf = Math.max(0, Math.min(1, 1 - cmnd[tauEst]));
        if (hz < MIN_HZ || hz > MAX_HZ || conf < 0.78) {
          frames[fi] = { t, midi: null, conf };
        } else {
          frames[fi] = { t, midi: hzToMidi(hz), conf };
        }
      }
    }

    if ((fi & 63) === 0) {
      onProgress?.(total === 0 ? 1 : fi / total);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return frames;
}

/** Fold ±1 semitone around an octave jump. Real leaps of a 7th stay put. */
export function repairOctaves(midi: Array<number | null>): Array<number | null> {
  const out = midi.slice();
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    if (prev == null || cur == null) continue;
    const diff = cur - prev;
    if (Math.abs(Math.abs(diff) - 12) <= 1.3) out[i] = cur - Math.sign(diff) * 12;
  }
  return out;
}

export function medianFilter(midi: Array<number | null>, radius: number): Array<number | null> {
  const out: Array<number | null> = new Array(midi.length);
  const window: number[] = [];
  for (let i = 0; i < midi.length; i++) {
    window.length = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j < 0 || j >= midi.length) continue;
      const v = midi[j];
      if (v != null) window.push(v);
    }
    if (window.length < radius) {
      out[i] = null;
      continue;
    }
    window.sort((a, b) => a - b);
    out[i] = window.length % 2 === 1
      ? window[window.length >> 1]
      : (window[window.length / 2 - 1] + window[window.length / 2]) / 2;
  }
  return out;
}

/** Moving average inside voiced runs only, so rests are not smeared into notes. */
export function smoothRuns(midi: Array<number | null>, radius: number): Array<number | null> {
  const out = midi.slice();
  let i = 0;
  while (i < midi.length) {
    if (midi[i] == null) {
      i++;
      continue;
    }
    let j = i;
    while (j < midi.length && midi[j] != null) j++;
    for (let k = i; k < j; k++) {
      const a = Math.max(i, k - radius);
      const b = Math.min(j - 1, k + radius);
      let s = 0;
      let c = 0;
      for (let t = a; t <= b; t++) {
        s += midi[t] as number;
        c++;
      }
      out[k] = s / c;
    }
    i = j;
  }
  return out;
}

export function smoothContour(raw: RawPitch[]): PitchFrame[] {
  const midis = repairOctaves(raw.map((f) => f.midi));
  const med = medianFilter(midis, 3);
  const repaired = repairOctaves(med);
  const smoothed = smoothRuns(repaired, 6);
  return raw.map((f, i) => ({
    t: f.t,
    midi: smoothed[i],
    conf: f.conf,
  }));
}

function halfWaveFlux(env: Float32Array): Float32Array {
  const flux = new Float32Array(env.length);
  for (let i = 1; i < env.length; i++) {
    const d = env[i] - env[i - 1];
    flux[i] = d > 0 ? d : 0;
  }
  // 3-point smooth
  const sm = new Float32Array(flux.length);
  for (let i = 0; i < flux.length; i++) {
    const a = flux[Math.max(0, i - 1)];
    const b = flux[i];
    const c = flux[Math.min(flux.length - 1, i + 1)];
    sm[i] = (a + 2 * b + c) / 4;
  }
  let peak = 0;
  for (let i = 0; i < sm.length; i++) if (sm[i] > peak) peak = sm[i];
  if (peak > 0) {
    for (let i = 0; i < sm.length; i++) sm[i] /= peak;
  }
  return sm;
}

export function onsetFlux(samples: Float32Array, sampleRate: number): { flux: Float32Array; hop: number } {
  const rate = 16000;
  const ds = downsample(samples, sampleRate, rate);
  // Silence before sample 0 so a vocal that starts on a note still has a rising edge.
  const pad = Math.round(rate * 0.06);
  const padded = new Float32Array(ds.length + pad);
  padded.set(ds, pad);
  const hop = Math.round(rate * 0.01);
  const win = hop * 2;
  const n = Math.max(0, Math.floor((padded.length - win) / hop));
  const energy = new Float32Array(n);
  const high = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = i * hop;
    let e = 0;
    let h = 0;
    let prev = 0;
    for (let j = 0; j < win; j++) {
      const s = padded[start + j];
      e += s * s;
      const d = s - prev;
      h += d * d;
      prev = s;
    }
    energy[i] = Math.log(1e-8 + e);
    high[i] = Math.log(1e-8 + h);
  }
  const a = halfWaveFlux(energy);
  const b = halfWaveFlux(high);
  const mixed = new Float32Array(n);
  for (let i = 0; i < n; i++) mixed[i] = 0.62 * a[i] + 0.38 * b[i];
  const padFrames = Math.round(pad / hop);
  const out = new Float32Array(Math.max(0, n - padFrames));
  for (let i = 0; i < n; i++) {
    const orig = i - padFrames;
    if (orig >= 0 && orig < out.length) out[orig] = Math.max(out[orig], mixed[i]);
    else if (out.length > 0) out[0] = Math.max(out[0], mixed[i]);
  }
  return { flux: out, hop: hop / rate };
}

function priorFor(bpm: number): number {
  const z = (bpm - 104) / 55;
  return Math.exp(-0.5 * z * z);
}

function scoreGrid(flux: Float32Array, period: number, phase: number): number {
  if (period < 4) return -Infinity;
  let sum = 0;
  let n = 0;
  let hits = 0;
  for (let t = phase; t < flux.length - 1; t += period) {
    const i = Math.round(t);
    const left = i > 0 ? flux[i - 1] : 0;
    const mid = flux[i] ?? 0;
    const right = i + 1 < flux.length ? flux[i + 1] : 0;
    const v = mid + 0.45 * left + 0.45 * right;
    sum += v;
    if (mid > 0.15) hits++;
    n++;
  }
  if (n < 3) return -Infinity;
  const hitRate = hits / n;
  return (sum / Math.sqrt(n)) * (0.5 + 0.5 * hitRate);
}

export function phaseAtBpm(flux: Float32Array, hopSec: number, bpm: number): number {
  const period = 60 / bpm / hopSec;
  const steps = 24;
  let best = 0;
  let bestScore = -Infinity;
  for (let p = 0; p < steps; p++) {
    const phase = (p / steps) * period;
    const score = scoreGrid(flux, period, phase);
    if (score > bestScore) {
      bestScore = score;
      best = phase;
    }
  }
  return best * hopSec;
}

export function downbeatAt(
  flux: Float32Array,
  hopSec: number,
  bpm: number,
  firstBeat: number,
  beatsPerBar: 3 | 4,
): number {
  const beatSec = 60 / bpm;
  const period = beatSec / hopSec;
  const bar = period * beatsPerBar;
  let bestShift = 0;
  let bestScore = -Infinity;
  for (let shift = 0; shift < beatsPerBar; shift++) {
    const origin = firstBeat / hopSec + shift * period;
    let sum = 0;
    let n = 0;
    for (let t = origin; t < flux.length; t += bar) {
      const i = Math.round(t);
      if (i < 0 || i >= flux.length) continue;
      sum += flux[i];
      n++;
    }
    const score = n > 0 ? sum / n : -Infinity;
    if (score > bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }
  let downbeat = firstBeat + bestShift * beatSec;
  const barSec = beatSec * beatsPerBar;
  while (downbeat - barSec > 0.03) downbeat -= barSec;
  return downbeat;
}

export function estimateTempo(flux: Float32Array, hopSec: number): { bpm: number; firstBeat: number } {
  let peak = 0;
  for (let i = 0; i < flux.length; i++) if (flux[i] > peak) peak = flux[i];
  if (peak < 1e-4 || flux.length < 20) return { bpm: 96, firstBeat: 0 };

  let bestBpm = 96;
  let bestScore = -Infinity;
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const period = 60 / bpm / hopSec;
    const steps = 16;
    let local = -Infinity;
    for (let p = 0; p < steps; p++) {
      const s = scoreGrid(flux, period, (p / steps) * period);
      if (s > local) local = s;
    }
    const score = local * priorFor(bpm);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }

  let refined = bestBpm;
  bestScore = -Infinity;
  for (let bpm = bestBpm - 1; bpm <= bestBpm + 1; bpm += 0.1) {
    const clamped = Math.max(60, Math.min(180, bpm));
    const period = 60 / clamped / hopSec;
    let local = -Infinity;
    const steps = 24;
    for (let p = 0; p < steps; p++) {
      const s = scoreGrid(flux, period, (p / steps) * period);
      if (s > local) local = s;
    }
    const score = local * priorFor(clamped);
    if (score > bestScore) {
      bestScore = score;
      refined = clamped;
    }
  }

  const bpm = Math.round(Math.max(60, Math.min(180, refined)));
  const firstBeat = phaseAtBpm(flux, hopSec, bpm);
  return { bpm, firstBeat };
}

export function estimateKey(frames: PitchFrame[]): { root: number; mode: Mode; score: number } {
  const hist = new Float64Array(12);
  for (let i = 0; i < frames.length; i++) {
    const m = frames[i].midi;
    if (m == null) continue;
    const prev = frames[i - 1]?.midi;
    const next = frames[i + 1]?.midi;
    let w = frames[i].conf;
    if (prev != null && next != null && Math.abs(prev - m) < 0.35 && Math.abs(next - m) < 0.35) w *= 1.7;
    hist[pitchClass(m)] += w;
  }
  let total = 0;
  for (let i = 0; i < 12; i++) total += hist[i];
  if (total < 4) return { root: 0, mode: "major", score: 0 };

  type Cand = { root: number; mode: Mode; score: number };
  let best: Cand = { root: 0, mode: "major", score: -Infinity };
  let second: Cand = { root: 0, mode: "minor", score: -Infinity };
  const rotated = new Float64Array(12);
  for (let root = 0; root < 12; root++) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      for (let i = 0; i < 12; i++) rotated[i] = profile[(i - root + 12) % 12];
      const score = pearson(hist, rotated);
      const cand = { root, mode, score };
      if (score > best.score) {
        second = best;
        best = cand;
      } else if (score > second.score) {
        second = cand;
      }
    }
  }

  const relative =
    best.mode !== second.mode &&
    ((best.mode === "major" ? best.root : second.root) + 12) % 12 ===
      (((best.mode === "minor" ? best.root : second.root) + 3) % 12);
  if (relative && best.score - second.score < 0.045) {
    const tonicMass = (c: Cand) => hist[c.root];
    if (tonicMass(second) > tonicMass(best) * 1.08) best = second;
  }
  return best;
}

export function waveformPeaks(samples: Float32Array, buckets = 720): WaveBin[] {
  const out: WaveBin[] = [];
  if (samples.length === 0) return out;
  const size = Math.max(1, Math.floor(samples.length / buckets));
  const n = Math.ceil(samples.length / size);
  for (let i = 0; i < n; i++) {
    let mn = 0;
    let mx = 0;
    const a = i * size;
    const b = Math.min(samples.length, a + size);
    for (let j = a; j < b; j++) {
      const s = samples[j];
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    out.push({ min: mn, max: mx });
  }
  return out;
}

export async function analyzeVocal(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (label: string, ratio: number) => void,
): Promise<Features> {
  const mono = normalizePeak(samples);
  const duration = mono.length / sampleRate;
  onProgress?.("Listening for the pulse", 0.04);
  const { flux, hop } = onsetFlux(mono, sampleRate);
  onProgress?.("Locking the bar grid", 0.18);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tempo = estimateTempo(flux, hop);
  onProgress?.("Following the vocal, smoothing vibrato", 0.28);
  const raw = await trackPitch(mono, sampleRate, (r) => {
    onProgress?.("Following the vocal, smoothing vibrato", 0.28 + r * 0.62);
  });
  const frames = smoothContour(raw);
  onProgress?.("Choosing a key", 0.94);
  const key = estimateKey(frames);
  let voiced = 0;
  for (const f of frames) if (f.midi != null) voiced++;
  onProgress?.("Choosing a key", 1);
  return {
    duration,
    sampleRate,
    waveform: waveformPeaks(mono),
    frames,
    frameHop: 80 / PITCH_RATE,
    flux,
    fluxHop: hop,
    detectedBpm: tempo.bpm,
    detectedFirstBeat: tempo.firstBeat,
    detectedRoot: key.root,
    detectedMode: key.mode,
    keyScore: key.score,
    voicedFraction: frames.length === 0 ? 0 : voiced / frames.length,
  };
}
