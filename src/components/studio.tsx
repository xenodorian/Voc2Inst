import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Music2, Pause, Play, RotateCcw, Upload } from "lucide-react";
import { analyzeVocal, mixToMono, type Features } from "@/lib/cantor/analyze";
import { arrange, type StyleId } from "@/lib/cantor/arrange";
import { makeDemoVocal } from "@/lib/cantor/demo";
import { BedPlayer, exportMix } from "@/lib/cantor/synth";
import { NOTE_NAMES, type Mode } from "@/lib/cantor/theory";
import { ScoreCanvas } from "@/components/score-canvas";

const STYLES: Array<{ id: StyleId; label: string; hint: string }> = [
  { id: "pad", label: "Pad", hint: "Sustained triads, one chord per bar, voiced in close position." },
  { id: "piano", label: "Piano", hint: "Block chords and a bass that follow the phrase without leaping." },
  { id: "arp", label: "Arpeggio", hint: "Broken chords that rise or fall with the vocal." },
  { id: "line", label: "Counterline", hint: "A diatonic line a third below. Leaps stay inside a fifth." },
];

function formatTime(sec: number): string {
  const safe = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  const whole = Math.floor(safe);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function Studio() {
  const playerRef = useRef<BedPlayer | null>(null);
  if (playerRef.current == null) playerRef.current = new BedPlayer();
  const fileRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const jobRef = useRef(0);

  const [features, setFeatures] = useState<Features | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [message, setMessage] = useState("Listening for the pulse");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState<StyleId>("pad");
  const [meter, setMeter] = useState<3 | 4>(4);
  const [bpmDraft, setBpmDraft] = useState<number | null>(null);
  const [rootDraft, setRootDraft] = useState<number | null>(null);
  const [modeDraft, setModeDraft] = useState<Mode | null>(null);
  const [bed, setBed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [capped, setCapped] = useState(false);

  const arrangement = useMemo(() => {
    if (!features) return null;
    return arrange(features, { bpm: bpmDraft, root: rootDraft, mode: modeDraft, meter, style });
  }, [features, bpmDraft, rootDraft, modeDraft, meter, style]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !arrangement) return;
    player.notes = arrangement.notes;
    player.style = style;
    if (player.playing) player.play(player.currentTime());
  }, [arrangement, style]);

  useEffect(() => {
    const write = () => {
      if (!timeRef.current) return;
      const now = playerRef.current?.currentTime() ?? 0;
      timeRef.current.textContent = `${formatTime(now)} / ${formatTime(features?.duration ?? 0)}`;
    };
    write();
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      write();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, features]);

  const shownBpm = bpmDraft ?? features?.detectedBpm ?? 96;
  const shownRoot = rootDraft ?? features?.detectedRoot ?? 0;
  const shownMode = modeDraft ?? features?.detectedMode ?? "major";
  const keyLabel = features ? `${NOTE_NAMES[shownRoot]} ${shownMode}` : "—";
  const styleHint = STYLES.find((item) => item.id === style)?.hint ?? "";
  const overridden = bpmDraft != null || rootDraft != null || modeDraft != null;

  const ingest = useCallback(
    async (name: string, samples: Float32Array, sampleRate: number, buffer: AudioBuffer) => {
      const id = ++jobRef.current;
      const player = playerRef.current;
      player?.pause();
      setPlaying(false);
      setFeatures(null);
      setFileName(name);
      setError(null);
      setCapped(false);
      setBpmDraft(null);
      setRootDraft(null);
      setModeDraft(null);
      setPhase("working");
      setProgress(0.02);
      setMessage("Listening for the pulse");
      try {
        const next = await analyzeVocal(samples, sampleRate, (label, ratio) => {
          if (id !== jobRef.current) return;
          setMessage(label);
          setProgress(ratio);
        });
        if (id !== jobRef.current || !player) return;
        player.vocal = buffer;
        player.origin = 0;
        setFeatures(next);
        setPhase("ready");
      } catch (err) {
        if (id !== jobRef.current) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : "Could not read that vocal.");
      }
    },
    [],
  );

  async function onFile(file: File) {
    const player = playerRef.current;
    if (!player) return;
    player.prime();
    setPhase("working");
    setMessage("Opening the take");
    setError(null);
    try {
      const encoded = await file.arrayBuffer();
      const audio = await player.prime().decodeAudioData(encoded.slice(0));
      const channels: Float32Array[] = [];
      for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
      await ingest(file.name, mixToMono(channels), audio.sampleRate, audio);
    } catch {
      setPhase("error");
      setError("That file didn't decode. Try a WAV or MP3 vocal.");
    }
  }

  function onDemo() {
    const player = playerRef.current;
    if (!player) return;
    player.prime();
    const samples = makeDemoVocal();
    const buffer = player.makeBuffer(samples, 44100);
    void ingest("Demo phrase", samples, 44100, buffer);
  }

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player || !features) return;
    if (player.playing) {
      player.pause();
      setPlaying(false);
      return;
    }
    let from = player.currentTime();
    if (from >= features.duration - 0.08) from = 0;
    player.play(from);
    setPlaying(true);
  }, [features]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code !== "Space") return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  async function onExport() {
    const player = playerRef.current;
    if (!player?.vocal || !arrangement) return;
    setExporting(true);
    setError(null);
    try {
      const blob = await exportMix(player.vocal, arrangement.notes, style, bed);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "cantor-bed.wav";
      anchor.click();
      URL.revokeObjectURL(url);
      setCapped(player.vocal.duration > 360);
    } catch {
      setError("The mix couldn't be rendered in this browser.");
    } finally {
      setExporting(false);
    }
  }

  const ready = phase === "ready" && features != null && arrangement != null;

  return (
    <main className="min-h-screen bg-bg text-fg">
      <div className="h-1 bg-brass" />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-xl">
            <p className="font-mono text-xs tracking-widest text-brass uppercase">Vocal studio</p>
            <h1 className="font-display text-4xl leading-tight text-fg md:text-5xl">Cantor</h1>
            <p className="mt-2 text-muted">A harmonic bed for a lone vocal. The voice leads. The chords wait for the bar.</p>
          </div>
          <div className="sm:text-right">
            <p className="font-display text-3xl leading-tight text-fg">{keyLabel}</p>
            <p className="font-mono text-sm text-muted">
              {ready ? `${shownBpm} bpm · ${meter}/4` : "Drop a vocal to begin"}
            </p>
          </div>
        </header>

        <section className="rounded-2xl border border-line bg-surface p-3 md:p-4">
          <div className="relative h-56 overflow-hidden rounded-xl md:h-80">
            <ScoreCanvas
              features={features}
              arrangement={arrangement}
              playing={playing}
              getTime={() => playerRef.current?.currentTime() ?? 0}
              onEnded={() => {
                playerRef.current?.pause();
                setPlaying(false);
              }}
            />
            {phase !== "ready" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface px-6 text-center">
                {phase === "working" ? (
              <>
                <p className="font-display text-2xl text-fg" role="status">
                  {message}
                </p>
                <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-raised">
                  <div className="h-full bg-brass" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              </>
            ) : phase === "error" ? (
              <>
                <p className="font-display text-2xl text-fg">That take didn't open.</p>
                <p className="max-w-sm text-sm text-muted">{error ?? "Try a WAV or MP3 vocal."}</p>
                <button type="button" className="inline-flex h-11 items-center gap-2 rounded-xl bg-brass px-4 text-sm font-medium text-bg" onClick={onDemo}>
                  <Music2 className="size-4" aria-hidden="true" />
                  Sound a demo phrase
                </button>
              </>
            ) : (
              <>
                <p className="font-display text-2xl text-fg">The staff is empty.</p>
                <p className="max-w-sm text-sm text-muted">
                  Drop a vocal, or sound a short phrase in C so you can hear the bed before you commit a take.
                </p>
                <button type="button" className="inline-flex h-11 items-center gap-2 rounded-xl bg-brass px-4 text-sm font-medium text-bg" onClick={onDemo}>
                  <Music2 className="size-4" aria-hidden="true" />
                  Sound a demo phrase
                </button>
              </>
            )}
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-brass px-4 text-sm font-medium text-bg disabled:opacity-40"
              onClick={toggle}
              disabled={!ready}
              aria-pressed={playing}
            >
              {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
              {playing ? "Pause" : "Play"}
            </button>
            <span ref={timeRef} className="font-mono text-sm text-muted">
              0:00 / 0:00
            </span>
            <button
              type="button"
              className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-raised px-4 text-sm text-fg disabled:opacity-40"
              onClick={() => void onExport()}
              disabled={!ready || exporting}
            >
              <Download className="size-4" aria-hidden="true" />
              {exporting ? "Rendering…" : "Export WAV"}
            </button>
            <p className="text-sm text-muted md:ml-auto">Ivory line, smoothed pitch. Brass blocks, scale-locked.</p>
          </div>
        </section>

        {error && phase === "ready" && (
          <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-brass" role="alert">
            {error}
          </p>
        )}
        {capped && <p className="text-sm text-muted">Export keeps the first six minutes.</p>}

        {ready && arrangement && (
          <div className="flex flex-col gap-2">
            <p className="font-mono text-xs tracking-widest text-muted uppercase">
              {overridden ? "Grid set by you" : "Grid from the vocal"}
              {features && features.voicedFraction < 0.08 ? " · sparse pitch" : ""}
            </p>
            {arrangement.chords.length === 0 ? (
              <p className="text-sm text-muted">No stable phrase to harmonize. The take may be too quiet or too spoken.</p>
            ) : (
              <ol className="flex flex-wrap gap-2">
                {arrangement.chords.map((chord, index) => (
                  <li key={`${chord.start}-${index}`} className="rounded-lg bg-surface px-3 py-2">
                    <span className="font-mono text-xs text-muted">{chord.degree}</span>
                    <span className="ml-2 font-display text-lg text-fg">{chord.symbol}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        <section className="grid gap-4 md:grid-cols-3">
          <label className="flex flex-col gap-2">
            <span className="font-mono text-xs tracking-widest text-muted uppercase">Key</span>
            <select
              className="h-11 rounded-xl border border-line bg-raised px-3 text-fg disabled:opacity-40"
              disabled={!ready}
              value={`${shownRoot}:${shownMode}`}
              onChange={(event) => {
                const [root, mode] = event.target.value.split(":");
                setRootDraft(Number(root));
                setModeDraft(mode === "minor" ? "minor" : "major");
              }}
            >
              {NOTE_NAMES.flatMap((name, root) =>
                (["major", "minor"] as const).map((mode) => (
                  <option key={`${root}-${mode}`} value={`${root}:${mode}`}>
                    {name} {mode}
                  </option>
                )),
              )}
            </select>
          </label>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs tracking-widest text-muted uppercase">Tempo</span>
              <span className="font-mono text-sm text-fg">{shownBpm}</span>
            </div>
            <input
              type="range"
              min={60}
              max={180}
              step={1}
              disabled={!ready}
              aria-label="Tempo in beats per minute"
              value={shownBpm}
              onChange={(event) => setBpmDraft(Number(event.target.value))}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className={`h-11 flex-1 rounded-xl border text-sm ${meter === 4 ? "border-brass bg-brass text-bg" : "border-line bg-raised text-fg"}`}
                onClick={() => setMeter(4)}
                disabled={!ready}
              >
                4/4
              </button>
              <button
                type="button"
                className={`h-11 flex-1 rounded-xl border text-sm ${meter === 3 ? "border-brass bg-brass text-bg" : "border-line bg-raised text-fg"}`}
                onClick={() => setMeter(3)}
                disabled={!ready}
              >
                3/4
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="font-mono text-xs tracking-widest text-muted uppercase">Bed level</span>
            <input
              type="range"
              min={0}
              max={1.6}
              step={0.01}
              aria-label="Backing track level"
              value={bed}
              onChange={(event) => {
                const value = Number(event.target.value);
                setBed(value);
                playerRef.current?.setBed(value);
              }}
            />
            <button
              type="button"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-line bg-raised text-sm text-fg disabled:opacity-40"
              disabled={!ready || !overridden}
              onClick={() => {
                setBpmDraft(null);
                setRootDraft(null);
                setModeDraft(null);
              }}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Use detected grid
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {STYLES.map((item) => {
              const active = style === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`h-11 rounded-xl border text-sm ${active ? "border-brass bg-brass text-bg" : "border-line bg-raised text-fg"}`}
                  aria-pressed={active}
                  onClick={() => setStyle(item.id)}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <p className="text-sm text-muted">{styleHint}</p>
        </section>

        <label
          className={`flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-6 text-center ${dragging ? "border-brass bg-surface" : "border-line bg-surface"}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void onFile(file);
          }}
        >
          <Upload className="size-5 text-brass" aria-hidden="true" />
          <span className="text-fg">{fileName ? fileName : "Drop a WAV or MP3 vocal"}</span>
          <span className="text-sm text-muted">{fileName ? "Drop another take to replace it" : "Or click to browse"}</span>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onFile(file);
            }}
          />
        </label>

        <ol className="grid gap-3 sm:grid-cols-3">
          <li className="rounded-xl bg-surface px-4 py-3">
            <p className="font-mono text-xs text-brass">01</p>
            <p className="mt-1 text-sm text-fg">Onsets lock the tempo and the downbeat before any chord is chosen.</p>
          </li>
          <li className="rounded-xl bg-surface px-4 py-3">
            <p className="font-mono text-xs text-brass">02</p>
            <p className="mt-1 text-sm text-fg">Pitch is median-smoothed so vibrato and jitter never move the harmony.</p>
          </li>
          <li className="rounded-xl bg-surface px-4 py-3">
            <p className="font-mono text-xs text-brass">03</p>
            <p className="mt-1 text-sm text-fg">One diatonic chord per bar. Passing tones and chromatic runs do not vote.</p>
          </li>
        </ol>

        <p className="font-mono text-xs tracking-widest text-muted uppercase">
          Onset grid · smoothed YIN · diatonic voice-leading
        </p>
      </div>
    </main>
  );
}
