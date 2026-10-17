import type { BedNote, StyleId } from "./arrange.ts";

type Patch = {
  waves: OscillatorType[];
  detunes: number[];
  cutoff: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
};

const HIGH: Record<StyleId, Patch> = {
  pad: {
    waves: ["sawtooth", "triangle"],
    detunes: [0, 7],
    cutoff: 820,
    attack: 0.085,
    decay: 0.2,
    sustain: 0.8,
    release: 0.3,
  },
  piano: {
    waves: ["triangle"],
    detunes: [0],
    cutoff: 1700,
    attack: 0.007,
    decay: 0.28,
    sustain: 0.15,
    release: 0.16,
  },
  arp: {
    waves: ["triangle"],
    detunes: [0],
    cutoff: 2000,
    attack: 0.005,
    decay: 0.13,
    sustain: 0.06,
    release: 0.07,
  },
  line: {
    waves: ["sine"],
    detunes: [0],
    cutoff: 2400,
    attack: 0.018,
    decay: 0.1,
    sustain: 0.74,
    release: 0.13,
  },
};

const BASS: Patch = {
  waves: ["sine"],
  detunes: [0],
  cutoff: 380,
  attack: 0.012,
  decay: 0.16,
  sustain: 0.62,
  release: 0.11,
};

function patchFor(style: StyleId, midi: number): Patch {
  if (midi < 50) {
    if (style === "pad") {
      return { ...BASS, attack: 0.07, decay: 0.18, sustain: 0.78, release: 0.28, cutoff: 340 };
    }
    return BASS;
  }
  return HIGH[style];
}

function later(time: number, prev: number): number {
  return time <= prev ? prev + 0.001 : time;
}

export function scheduleNote(
  ctx: BaseAudioContext,
  dest: AudioNode,
  when: number,
  dur: number,
  midi: number,
  peak: number,
  style: StyleId,
  sink?: AudioScheduledSourceNode[],
): void {
  if (!Number.isFinite(midi) || !Number.isFinite(dur) || dur <= 0.025 || peak <= 0) return;
  const patch = patchFor(style, midi);
  const freq = 440 * 2 ** ((midi - 69) / 12);
  const pre = ctx.createGain();
  pre.gain.value = 1 / patch.waves.length;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = patch.cutoff;
  filter.Q.value = 0.55;
  const env = ctx.createGain();
  pre.connect(filter);
  filter.connect(env);
  env.connect(dest);

  const attackEnd = later(when + Math.min(patch.attack, Math.max(0.004, dur * 0.35)), when);
  const decayEnd = later(Math.min(when + dur, attackEnd + patch.decay), attackEnd);
  const releaseStart = later(Math.max(decayEnd, when + dur), decayEnd);
  const releaseEnd = later(releaseStart + patch.release, releaseStart);
  const sustain = peak * patch.sustain;
  env.gain.setValueAtTime(0.0001, when);
  env.gain.linearRampToValueAtTime(Math.max(peak, 0.0002), attackEnd);
  env.gain.linearRampToValueAtTime(Math.max(sustain, 0.0001), decayEnd);
  if (releaseStart - decayEnd > 0.0015) env.gain.setValueAtTime(Math.max(sustain, 0.0001), releaseStart);
  env.gain.linearRampToValueAtTime(0.0001, releaseEnd);

  for (let i = 0; i < patch.waves.length; i++) {
    const osc = ctx.createOscillator();
    osc.type = patch.waves[i];
    osc.frequency.value = freq;
    osc.detune.value = patch.detunes[i] ?? 0;
    osc.connect(pre);
    osc.start(when);
    osc.stop(releaseEnd + 0.02);
    sink?.push(osc);
  }
}

function writeStr(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  const block = channels * 2;
  const bytes = new ArrayBuffer(44 + length * block);
  const view = new DataView(bytes);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + length * block, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * block, true);
  view.setUint16(32, block, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, length * block, true);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}

export async function exportMix(
  vocal: AudioBuffer,
  notes: BedNote[],
  style: StyleId,
  bedLevel: number,
  maxSec = 360,
): Promise<Blob> {
  const sampleRate = vocal.sampleRate;
  const dur = Math.min(maxSec, vocal.duration + 0.45);
  const offline = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
  const vocalGain = offline.createGain();
  vocalGain.gain.value = 0.92;
  vocalGain.connect(offline.destination);
  const bedGain = offline.createGain();
  bedGain.gain.value = bedLevel;
  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 8;
  comp.ratio.value = 2.4;
  comp.attack.value = 0.01;
  comp.release.value = 0.18;
  bedGain.connect(comp);
  comp.connect(offline.destination);

  const src = offline.createBufferSource();
  src.buffer = vocal;
  src.connect(vocalGain);
  src.start(0);

  for (const note of notes) {
    if (note.start >= dur) continue;
    const noteDur = Math.min(note.duration, dur - note.start);
    scheduleNote(offline, bedGain, note.start, noteDur, note.midi, note.gain, style);
  }
  const rendered = await offline.startRendering();
  return encodeWav(rendered);
}

export class BedPlayer {
  ctx: AudioContext | null = null;
  vocal: AudioBuffer | null = null;
  notes: BedNote[] = [];
  style: StyleId = "pad";
  bedLevel = 1;
  playing = false;
  private nodes: AudioScheduledSourceNode[] = [];
  private vocalGain: GainNode | null = null;
  private bedGain: GainNode | null = null;
  private startedAt = 0;
  origin = 0;

  prime(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.vocalGain = ctx.createGain();
      this.bedGain = ctx.createGain();
      this.vocalGain.gain.value = 0.92;
      this.bedGain.gain.value = this.bedLevel;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 8;
      comp.ratio.value = 2.4;
      comp.attack.value = 0.01;
      comp.release.value = 0.18;
      this.bedGain.connect(comp);
      comp.connect(ctx.destination);
      this.vocalGain.connect(ctx.destination);
    }
    void this.ctx.resume();
    return this.ctx;
  }

  setBed(level: number) {
    this.bedLevel = level;
    if (this.bedGain && this.ctx) this.bedGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.03);
  }

  currentTime(): number {
    if (!this.playing || !this.ctx) return this.origin;
    return Math.max(0, this.ctx.currentTime - this.startedAt);
  }

  makeBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
    const ctx = this.prime();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }

  private stopNodes() {
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.nodes = [];
  }

  play(from: number) {
    const ctx = this.prime();
    this.stopNodes();
    const when = ctx.currentTime + 0.06;
    const offset = Math.max(0, from);
    this.startedAt = when - offset;
    this.origin = offset;
    this.playing = true;
    if (this.vocal && this.vocalGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.vocal;
      src.connect(this.vocalGain);
      const startAt = Math.min(offset, Math.max(0, this.vocal.duration - 0.02));
      src.start(when, startAt);
      this.nodes.push(src);
    }
    const dest = this.bedGain;
    if (!dest) return;
    for (const note of this.notes) {
      const end = note.start + note.duration;
      if (end <= offset + 0.012) continue;
      const local = Math.max(note.start, offset);
      scheduleNote(ctx, dest, when + (local - offset), end - local, note.midi, note.gain, this.style, this.nodes);
    }
  }

  pause() {
    if (this.ctx && this.playing) this.origin = Math.max(0, this.ctx.currentTime - this.startedAt);
    this.stopNodes();
    this.playing = false;
  }
}
