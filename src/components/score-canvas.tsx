import { useEffect, useRef } from "react";
import type { Features } from "@/lib/cantor/analyze";
import type { Arrangement } from "@/lib/cantor/arrange";

const INK = "#221e1a";
const IVORY = "#f4ecdf";
const MUTED = "#b3a18a";
const BRASS = "#e0a04a";
const LINE = "#3c342c";

type Props = {
  features: Features | null;
  arrangement: Arrangement | null;
  getTime: () => number;
  playing: boolean;
  onEnded: () => void;
};

export function ScoreCanvas({ features, arrangement, getTime, playing, onEnded }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getTimeRef = useRef(getTime);
  const onEndedRef = useRef(onEnded);
  getTimeRef.current = getTime;
  onEndedRef.current = onEnded;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    let alive = true;
    let ended = false;
    const tick = () => {
      if (!alive) return;
      const time = getTimeRef.current();
      paint(canvas, features, arrangement, time);
      if (playing && features && time >= features.duration - 0.05) {
        if (!ended) {
          ended = true;
          onEndedRef.current();
        }
      } else if (!playing) {
        ended = false;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
    };
  }, [features, arrangement, playing]);

  return <canvas ref={canvasRef} className="block h-full w-full" aria-hidden="true" />;
}

function paint(
  canvas: HTMLCanvasElement,
  features: Features | null,
  arrangement: Arrangement | null,
  playhead: number,
) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, w, h);

  const top = h * 0.22;
  const bot = h * 0.9;
  const left = Math.round(w * 0.03);
  const right = Math.round(w * 0.985);
  const plotW = Math.max(1, right - left);

  ctx.strokeStyle = LINE;
  ctx.lineWidth = Math.max(1, dpr);
  for (let i = 0; i < 5; i++) {
    const y = top + ((bot - top) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  if (!features || !arrangement || features.duration <= 0) return;

  const dur = features.duration;
  const xOf = (t: number) => left + (Math.min(dur, Math.max(0, t)) / dur) * plotW;

  const wave = features.waveform;
  const midY = (top + bot) / 2;
  const amp = (bot - top) * 0.36;
  ctx.beginPath();
  ctx.moveTo(left, midY);
  for (let i = 0; i < wave.length; i++) {
    ctx.lineTo(left + (i / Math.max(1, wave.length)) * plotW, midY - wave[i].max * amp);
  }
  for (let i = wave.length - 1; i >= 0; i--) {
    ctx.lineTo(left + (i / Math.max(1, wave.length)) * plotW, midY - wave[i].min * amp);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(224, 160, 74, 0.16)";
  ctx.fill();

  let lo = 58;
  let hi = 74;
  let found = false;
  for (const frame of features.frames) {
    if (frame.midi == null) continue;
    if (!found) {
      lo = frame.midi;
      hi = frame.midi;
      found = true;
    } else {
      if (frame.midi < lo) lo = frame.midi;
      if (frame.midi > hi) hi = frame.midi;
    }
  }
  lo -= 3;
  hi += 3;
  if (hi - lo < 12) {
    const mid = (hi + lo) / 2;
    lo = mid - 6;
    hi = mid + 6;
  }
  const yOf = (midi: number) => bot - ((midi - lo) / (hi - lo)) * (bot - top);

  const barDur = (60 / arrangement.bpm) * arrangement.meter;
  let bar = arrangement.downbeat;
  while (bar > 0.001) bar -= barDur;
  ctx.textBaseline = "top";
  while (bar < dur + barDur * 0.2) {
    const x = xOf(Math.max(0, bar));
    ctx.strokeStyle = LINE;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.moveTo(x, h * 0.08);
    ctx.lineTo(x, bot);
    ctx.stroke();
    const chord = arrangement.chords.find((mark) => Math.abs(mark.start - Math.max(0, bar)) < barDur * 0.4);
    const width = xOf(Math.min(dur, bar + barDur)) - x;
    if (chord && width > 28 * dpr && bar < dur) {
      ctx.fillStyle = BRASS;
      ctx.font = `${Math.round(15 * dpr)}px Fraunces, Georgia, serif`;
      ctx.fillText(chord.symbol, x + 6 * dpr, h * 0.045);
    }
    bar += barDur;
  }

  for (const cell of arrangement.cells) {
    if (cell.midi == null) continue;
    const x = xOf(cell.start);
    const width = Math.max(dpr * 2, (cell.duration / dur) * plotW - dpr);
    const y = yOf(cell.midi);
    const solid = cell.diatonic && !cell.passing;
    ctx.globalAlpha = solid ? 0.92 : 0.4;
    ctx.fillStyle = solid ? BRASS : MUTED;
    ctx.fillRect(x, y - 1.5 * dpr, width, 3 * dpr);
  }
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.strokeStyle = IVORY;
  ctx.lineWidth = 1.4 * dpr;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  let drawing = false;
  const step = Math.max(1, Math.floor(features.frames.length / 1000));
  for (let i = 0; i < features.frames.length; i += step) {
    const frame = features.frames[i];
    if (frame.midi == null) {
      drawing = false;
      continue;
    }
    const x = xOf(frame.t);
    const y = yOf(frame.midi);
    if (!drawing) {
      ctx.moveTo(x, y);
      drawing = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  if (playhead >= 0) {
    const x = xOf(playhead);
    ctx.strokeStyle = BRASS;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, h * 0.04);
    ctx.lineTo(x, bot);
    ctx.stroke();
  }
}
