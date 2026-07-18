import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw, ImagePlus } from "lucide-react";

const SIZE = 320;
const CENTER = SIZE / 2;
const RADIUS = CENTER - 6;
const MAX_SECONDS = 60 * 60; // 60 min max

function fmt(s: number) {
  s = Math.max(0, Math.ceil(s));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Build an SVG path for a pie slice from top (12 o'clock) clockwise, fraction 0..1 */
function piePath(fraction: number): string {
  const f = Math.min(1, Math.max(0, fraction));
  if (f <= 0) return "";
  if (f >= 1) {
    // Full circle via two arcs
    return `M ${CENTER} ${CENTER - RADIUS} A ${RADIUS} ${RADIUS} 0 1 1 ${CENTER - 0.001} ${CENTER - RADIUS} Z`;
  }
  const angle = f * Math.PI * 2;
  const x = CENTER + RADIUS * Math.sin(angle);
  const y = CENTER - RADIUS * Math.cos(angle);
  const largeArc = f > 0.5 ? 1 : 0;
  return `M ${CENTER} ${CENTER} L ${CENTER} ${CENTER - RADIUS} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x} ${y} Z`;
}

export function PhotoTimer() {
  const [photos, setPhotos] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [duration, setDuration] = useState(15 * 60); // seconds, initial 15 min
  const [remaining, setRemaining] = useState(15 * 60);
  const [running, setRunning] = useState(false);
  const [alarming, setAlarming] = useState(false);
  const dragging = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const alarmStopRef = useRef<(() => void) | null>(null);

  const photo = photos[currentIndex] ?? null;

  // Timer tick
  useEffect(() => {
    if (!running) return;
    const start = performance.now();
    const startRemaining = remaining;
    let raf = 0;
    const tick = () => {
      const elapsed = (performance.now() - start) / 1000;
      const next = startRemaining - elapsed;
      if (next <= 0) {
        setRemaining(0);
        setRunning(false);
        setAlarming(true);
        return;
      }
      setRemaining(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Alarm sound
  useEffect(() => {
    if (!alarming) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    audioCtxRef.current = ctx;
    let stopped = false;
    const beep = () => {
      if (stopped) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.4, ctx.currentTime + 0.02);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.55);
    };
    beep();
    const iv = setInterval(beep, 700);
    alarmStopRef.current = () => {
      stopped = true;
      clearInterval(iv);
      ctx.close();
    };
    return () => {
      stopped = true;
      clearInterval(iv);
      ctx.close();
    };
  }, [alarming]);

  const stopAlarm = () => {
    alarmStopRef.current?.();
    setAlarming(false);
  };

  const setFromPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    // angle from top, clockwise, 0..2π
    let a = Math.atan2(x, -y);
    if (a < 0) a += Math.PI * 2;
    const fraction = a / (Math.PI * 2);
    // Snap to 30-second increments
    let secs = Math.round((fraction * MAX_SECONDS) / 30) * 30;
    if (secs < 30) secs = 30;
    setDuration(secs);
    setRemaining(secs);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (running || alarming) return;
    dragging.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    setFromPoint(e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setFromPoint(e.clientX, e.clientY);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    const urls = files.map((f) => URL.createObjectURL(f));
    setPhotos((prev) => [...prev, ...urls]);
    e.target.value = "";
  };

  const togglePlay = () => {
    if (alarming) {
      stopAlarm();
      // Advance to next player's photo
      setCurrentIndex((i) => (photos.length ? (i + 1) % photos.length : 0));
      setRemaining(duration);
      setRunning(true);
      return;
    }
    if (remaining <= 0) {
      setRemaining(duration);
      setRunning(true);
      return;
    }
    setRunning((r) => !r);
  };

  const reset = () => {
    stopAlarm();
    setRunning(false);
    setRemaining(duration);
  };

  const fraction = duration > 0 ? remaining / duration : 0;
  const path = piePath(fraction);
  const lowTime = running && remaining <= 10 && remaining > 0;
  const clearAllPhotos = () => {
    photos.forEach((u) => URL.revokeObjectURL(u));
    setPhotos([]);
    setCurrentIndex(0);
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-between py-10 px-6 bg-background text-foreground select-none">
      <header className="w-full flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Photo Timer</h1>
        <button
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card/40 backdrop-blur px-4 py-2 text-sm hover:bg-card/70 transition"
        >
          <ImagePlus className="h-4 w-4" />
          {photos.length ? `Add photo (${photos.length})` : "Add photos"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handlePhoto}
        />
      </header>

      <div className="relative flex items-center justify-center">
        <svg
          ref={svgRef}
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className={`touch-none transition-transform ${alarming ? "animate-pulse" : ""} ${lowTime ? "animate-[pulse_0.6s_ease-in-out_infinite]" : ""}`}
          style={lowTime ? { filter: "drop-shadow(0 0 12px oklch(0.7 0.2 25))" } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <defs>
            <clipPath id="pieClip">
              <path d={path} />
            </clipPath>
            <pattern
              id="photoPattern"
              patternUnits="userSpaceOnUse"
              width={SIZE}
              height={SIZE}
            >
              {photo ? (
                <image
                  href={photo}
                  x={0}
                  y={0}
                  width={SIZE}
                  height={SIZE}
                  preserveAspectRatio="xMidYMid slice"
                />
              ) : (
                <rect width={SIZE} height={SIZE} fill="oklch(0.6 0.15 260)" />
              )}
            </pattern>
          </defs>

          {/* Empty ring background */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="oklch(0.28 0.02 270)"
            strokeWidth={2}
          />
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="oklch(0.2 0.02 270 / 0.6)"
          />

          {/* Pie of remaining time filled with photo */}
          {fraction > 0 && (
            <g clipPath="url(#pieClip)">
              <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="url(#photoPattern)" />
            </g>
          )}

          {/* Outer ring */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="oklch(0.98 0.005 260 / 0.9)"
            strokeWidth={3}
          />

          {/* Handle indicator on the edge at current fraction */}
          {!running && !alarming && (
            <circle
              cx={CENTER + RADIUS * Math.sin(fraction * Math.PI * 2)}
              cy={CENTER - RADIUS * Math.cos(fraction * Math.PI * 2)}
              r={10}
              fill="oklch(0.98 0.005 260)"
              stroke="oklch(0.14 0.02 270)"
              strokeWidth={2}
            />
          )}
        </svg>

        {/* Time readout */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div
            className="text-5xl font-semibold tabular-nums drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]"
            style={{ color: "oklch(0.98 0.005 260)" }}
          >
            {fmt(remaining)}
          </div>
          <div className="mt-1 text-xs uppercase tracking-widest text-white/70">
            {alarming
              ? "Next player!"
              : photos.length > 1
                ? `Turn ${currentIndex + 1} of ${photos.length}`
                : running
                  ? "Running"
                  : "Drag to set"}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <button
          onClick={reset}
          className="h-12 w-12 rounded-full border border-border bg-card/40 backdrop-blur flex items-center justify-center hover:bg-card/70 transition"
          aria-label="Reset"
        >
          <RotateCcw className="h-5 w-5" />
        </button>
        <button
          onClick={togglePlay}
          className="h-16 w-16 rounded-full flex items-center justify-center shadow-lg transition active:scale-95"
          style={{
            background: alarming
              ? "oklch(0.7 0.2 25)"
              : "oklch(0.98 0.005 260)",
            color: "oklch(0.14 0.02 270)",
          }}
          aria-label={running ? "Pause" : "Play"}
        >
          {running ? <Pause className="h-7 w-7" /> : <Play className="h-7 w-7 ml-1" />}
        </button>
        <button
          onClick={clearAllPhotos}
          disabled={!photos.length}
          className="h-12 w-12 rounded-full border border-border bg-card/40 backdrop-blur flex items-center justify-center text-xs hover:bg-card/70 transition disabled:opacity-30"
          aria-label="Clear photos"
        >
          Clear
        </button>
      </div>
    </div>
  );
}