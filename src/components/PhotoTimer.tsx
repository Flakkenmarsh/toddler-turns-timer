import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw, Plus, Trash2, Pencil, Users } from "lucide-react";

const SIZE = 320;
const CENTER = SIZE / 2;
const RADIUS = CENTER - 6;
const MIN_SECONDS = 30;
const MAX_SECONDS = 30 * 60; // 30 min max

const DRAG_THRESHOLD_PX = 6;
const RECENTS_KEY = "photoTimer.recentImages.v1";
const MAX_RECENTS = 10;

type Player = { id: string; name: string; photo: string | null };

const uid = () => Math.random().toString(36).slice(2, 10);

function fmt(s: number) {
  s = Math.max(0, Math.ceil(s));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
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
  const [players, setPlayers] = useState<Player[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [duration, setDuration] = useState(5 * 60); // seconds, initial 5 min
  const [remaining, setRemaining] = useState(5 * 60);
  const [running, setRunning] = useState(false);
  const [alarming, setAlarming] = useState(false);
  const [showRoster, setShowRoster] = useState(false);
  const [pickerPlayerId, setPickerPlayerId] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const dragging = useRef(false);
  const dragStart = useRef({ angle: 0, duration: 0, x: 0, y: 0, hasMoved: false });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rosterRef = useRef<HTMLDivElement | null>(null);
  const rosterButtonRef = useRef<HTMLButtonElement | null>(null);
  const photoInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const modalPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const alarmStopRef = useRef<(() => void) | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const [flashOn, setFlashOn] = useState(true);

  // Load recents from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setRecents(parsed.filter((x) => typeof x === "string").slice(0, MAX_RECENTS));
      }
    } catch {
      /* noop */
    }
  }, []);

  const persistRecents = (list: string[]) => {
    setRecents(list);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
    } catch {
      /* noop, quota */
    }
  };

  const pushRecent = (dataUrl: string) => {
    const next = [dataUrl, ...recents.filter((u) => u !== dataUrl)].slice(0, MAX_RECENTS);
    persistRecents(next);
  };

  const removeRecent = (dataUrl: string) => {
    persistRecents(recents.filter((u) => u !== dataUrl));
  };

  const currentPlayer = players[currentIndex] ?? null;
  const photo = currentPlayer?.photo ?? null;

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

  // Keep screen awake while running
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
    };
    const request = async () => {
      try {
        const sentinel = await nav.wakeLock?.request("screen");
        if (sentinel) {
          if (cancelled) {
            sentinel.release().catch(() => {});
          } else {
            wakeLockRef.current = sentinel;
          }
        }
      } catch {
        /* noop */
      }
    };
    request();
    const onVis = () => {
      if (document.visibilityState === "visible" && running) request();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [running]);

  // Flash effect while alarming
  useEffect(() => {
    if (!alarming) {
      setFlashOn(true);
      return;
    }
    setFlashOn(true);
    const iv = setInterval(() => setFlashOn((f) => !f), 350);
    return () => clearInterval(iv);
  }, [alarming]);

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

  // Auto-close roster when touching outside the panel or trigger button
  useEffect(() => {
    if (!showRoster) return;
    const close = (e: PointerEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        rosterRef.current &&
        rosterButtonRef.current &&
        !rosterRef.current.contains(target) &&
        !rosterButtonRef.current.contains(target)
      ) {
        setShowRoster(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [showRoster]);

  const stopAlarm = () => {
    alarmStopRef.current?.();
    setAlarming(false);
  };

  const angleFromPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    // angle from top, clockwise, 0..2π
    let a = Math.atan2(x, -y);
    if (a < 0) a += Math.PI * 2;
    return a;
  }, []);

  const setDurationFromDrag = useCallback((clientX: number, clientY: number) => {
    const currentAngle = angleFromPoint(clientX, clientY);
    let delta = currentAngle - dragStart.current.angle;
    // Normalize to the smallest rotation direction (-π..π) so dragging never loops around.
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;

    const deltaSeconds = (delta / (Math.PI * 2)) * MAX_SECONDS;
    let next = dragStart.current.duration + deltaSeconds;
    // Snap to 30-second increments
    next = Math.round(next / 30) * 30;
    // Clamp: dragging stops at 00:30 and 30:00.
    next = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, next));

    setDuration(next);
    setRemaining(next);
  }, [angleFromPoint]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (alarming) {
      stopAlarm();
      if (players.length) {
        setCurrentIndex((i) => (i + 1) % players.length);
      }
      setRemaining(duration);
      return;
    }
    const el = e.target as Element;
    el.setPointerCapture(e.pointerId);
    dragging.current = true;
    dragStart.current = {
      angle: angleFromPoint(e.clientX, e.clientY),
      duration,
      x: e.clientX,
      y: e.clientY,
      hasMoved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      dragStart.current.hasMoved = true;
      // Pause if the user begins dragging while the timer is running.
      if (running) setRunning(false);
    }
    if (dragStart.current.hasMoved) {
      setDurationFromDrag(e.clientX, e.clientY);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasDragging = dragging.current;
    dragging.current = false;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (!wasDragging) return;
    if (!dragStart.current.hasMoved) {
      // A clean tap toggles play/pause.
      if (remaining <= 0) {
        setRemaining(duration);
        setRunning(true);
      } else {
        setRunning((r) => !r);
      }
    }
  };

  const addPlayer = () => {
    setPlayers((prev) => [
      ...prev,
      { id: uid(), name: `Player ${prev.length + 1}`, photo: null },
    ]);
  };
  const renamePlayer = (id: string, name: string) => {
    setPlayers((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
  };
  const removePlayer = (id: string) => {
    setPlayers((prev) => {
      const next = prev.filter((p) => p.id !== id);
      if (currentIndex >= next.length) setCurrentIndex(0);
      return next;
    });
  };
  const assignPhoto = (id: string, dataUrl: string) => {
    setPlayers((prev) => prev.map((p) => (p.id === id ? { ...p, photo: dataUrl } : p)));
  };
  const setPlayerPhotoFromFile = async (id: string, file: File) => {
    try {
      const dataUrl = await fileToDataUrl(file);
      assignPhoto(id, dataUrl);
      pushRecent(dataUrl);
    } catch {
      /* noop */
    }
  };

  const togglePlay = () => {
    if (alarming) {
      stopAlarm();
      setCurrentIndex((i) => (players.length ? (i + 1) % players.length : 0));
      setRemaining(duration);
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
  // While alarming, show the full circle of the just-ended player's photo so it can flash.
  const displayFraction = alarming ? 1 : fraction;
  const path = piePath(displayFraction);
  // Marker reflects the currently-set duration on the outer ring.
  const markerFraction = duration / MAX_SECONDS;
  const showMarker = !running && !alarming;

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-between py-10 px-6 bg-background text-foreground select-none">
      <header className="w-full flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Photo Timer</h1>
        <button
          ref={rosterButtonRef}
          onClick={() => setShowRoster((s) => !s)}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card/40 backdrop-blur px-4 py-2 text-sm hover:bg-card/70 transition"
        >
          <Users className="h-4 w-4" />
          Players ({players.length})
        </button>
      </header>

      {showRoster && (
        <div
          ref={rosterRef}
          className="w-full max-w-md rounded-2xl border border-border bg-card/60 backdrop-blur p-3 space-y-2"
        >
          {players.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-2">
              No players yet. Add one to start a turn rotation.
            </p>
          )}
          {players.map((p, i) => (
            <div
              key={p.id}
              className={`flex items-center gap-2 rounded-xl px-2 py-2 ${i === currentIndex ? "bg-primary/10" : ""}`}
            >
              <button
                onClick={() => setPickerPlayerId(p.id)}
                className="h-10 w-10 rounded-full overflow-hidden border border-border bg-muted flex items-center justify-center shrink-0"
                aria-label="Set photo"
              >
                {p.photo ? (
                  <img src={p.photo} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              <input
                ref={(el) => {
                  photoInputRefs.current[p.id] = el;
                }}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setPlayerPhotoFromFile(p.id, f);
                    setPickerPlayerId(null);
                  }
                  e.target.value = "";
                }}
              />
              <input
                value={p.name}
                onChange={(e) => renamePlayer(p.id, e.target.value)}
                className="flex-1 bg-transparent border-b border-border/60 focus:border-primary outline-none text-sm py-1"
              />
              <button
                onClick={() => setCurrentIndex(i)}
                className="text-xs rounded-full px-2 py-1 border border-border hover:bg-card/70"
              >
                {i === currentIndex ? "Active" : "Set"}
              </button>
              <button
                onClick={() => removePlayer(p.id)}
                className="h-8 w-8 rounded-full flex items-center justify-center hover:bg-destructive/20 text-destructive"
                aria-label="Remove"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            onClick={addPlayer}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-2 text-sm hover:bg-card/70 transition"
          >
            <Plus className="h-4 w-4" /> Add player
          </button>
        </div>
      )}

      <div className="min-h-10 text-3xl font-semibold tracking-tight text-center">
        {currentPlayer ? currentPlayer.name : ""}
      </div>

      <div className="relative flex items-center justify-center">
        <svg
          ref={svgRef}
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className={`touch-none transition-transform ${alarming ? "animate-pulse" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <defs>
            <clipPath id="pieClip">
              <path d={path} />
            </clipPath>
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
          {displayFraction > 0 && (
            <g clipPath="url(#pieClip)" opacity={alarming && !flashOn ? 0 : 1}>
              {photo ? (
                <image
                  key={currentPlayer?.id ?? "none"}
                  href={photo}
                  x={0}
                  y={0}
                  width={SIZE}
                  height={SIZE}
                  preserveAspectRatio="xMidYMid slice"
                />
              ) : (
                <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="oklch(0.6 0.15 260)" />
              )}
              {/* Preload other players' images so switching turns is instant */}
              {players.map((p) =>
                p.photo && p.id !== currentPlayer?.id ? (
                  <image
                    key={`preload-${p.id}`}
                    href={p.photo}
                    x={0}
                    y={0}
                    width={1}
                    height={1}
                    opacity={0}
                    preserveAspectRatio="xMidYMid slice"
                  />
                ) : null,
              )}
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

          {/* Handle indicator on the edge at current duration */}
          {showMarker && (
            <circle
              cx={CENTER + RADIUS * Math.sin(markerFraction * Math.PI * 2)}
              cy={CENTER - RADIUS * Math.cos(markerFraction * Math.PI * 2)}
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
              : players.length > 1
                ? `Turn ${currentIndex + 1} of ${players.length}`
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
      </div>

      {pickerPlayerId && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setPickerPlayerId(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-2xl sm:rounded-2xl border border-border bg-card p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Choose photo</h2>
              <button
                onClick={() => setPickerPlayerId(null)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>
            <button
              onClick={() => modalPhotoInputRef.current?.click()}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-3 text-sm hover:bg-card/70 transition"
            >
              <Plus className="h-4 w-4" /> Pick new photo from device
            </button>
            <input
              ref={modalPhotoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && pickerPlayerId) {
                  setPlayerPhotoFromFile(pickerPlayerId, f);
                  setPickerPlayerId(null);
                }
                e.target.value = "";
              }}
            />
            {recents.length > 0 ? (
              <>
                <p className="text-xs text-muted-foreground">Recent photos</p>
                <div className="grid grid-cols-4 gap-2">
                  {recents.map((url) => (
                    <div key={url} className="relative group">
                      <button
                        onClick={() => {
                          assignPhoto(pickerPlayerId, url);
                          pushRecent(url);
                          setPickerPlayerId(null);
                        }}
                        className="aspect-square w-full rounded-lg overflow-hidden border border-border bg-muted"
                      >
                        <img src={url} alt="" className="h-full w-full object-cover" />
                      </button>
                      <button
                        onClick={() => removeRecent(url)}
                        className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-80 hover:opacity-100"
                        aria-label="Remove recent"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-2">
                No recent photos yet. Pick one to start building your list (stored only on this device).
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
