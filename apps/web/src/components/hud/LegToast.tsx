import { useEffect, useRef, useState } from 'react';

import { legToast } from '../../game/hud.js';
import { useAppStore } from '../../store.js';

const TOAST_MS = 4000;
const MAX_TOASTS = 3;

interface Toast {
  id: number;
  text: string;
  tone: 'on' | 'neutral';
  expiresAt: number;
}

/**
 * Leg-complete toasts under the route strip: 4 s each, at most 3 on screen.
 * Events are drained with a cursor over the store's (capped) event list, the
 * same convention the game director uses.
 */
export default function LegToast() {
  const session = useAppStore((state) => state.session);
  const events = useAppStore((state) => state.events);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const cursor = useRef({ sessionId: '', ts: -1, count: 0 });
  const nextId = useRef(1);

  useEffect(() => {
    if (session === null) return;
    const c = cursor.current;
    if (c.sessionId !== session.id) {
      c.sessionId = session.id;
      c.ts = -1;
      c.count = 0;
      setToasts([]);
    }
    let i = 0;
    while (i < events.length && events[i]!.ts < c.ts) i++;
    let skip = c.count;
    while (i < events.length && events[i]!.ts === c.ts && skip > 0) {
      i++;
      skip--;
    }
    const added: Toast[] = [];
    for (; i < events.length; i++) {
      const event = events[i]!;
      if (event.ts > c.ts) {
        c.ts = event.ts;
        c.count = 1;
      } else if (event.ts === c.ts) {
        c.count++;
      }
      if (event.kind !== 'legCompleted' || !event.objective) continue;
      const rider = session.riders.find((r) => r.riderId === event.riderId);
      const toast = legToast(
        {
          legKind: event.legKind,
          leg: rider?.legs?.[event.legIndex] ?? null,
          clean: event.clean,
          targetedS: event.targetedS,
          onTargetS: event.onTargetS,
        },
        session.riders.length > 1 ? (rider?.name ?? null) : null,
      );
      added.push({ id: nextId.current++, text: toast.text, tone: toast.tone, expiresAt: Date.now() + TOAST_MS });
    }
    if (added.length > 0) setToasts((prev) => [...prev, ...added].slice(-MAX_TOASTS));
  }, [events, session]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setToasts((prev) => {
        const next = prev.filter((toast) => toast.expiresAt > now);
        return next.length === prev.length ? prev : next;
      });
    }, 250);
    return () => window.clearInterval(id);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[18.5%] z-30 flex flex-col items-center gap-[clamp(4px,0.42vw,14px)]">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`animate-toast-in rounded-full border bg-void/75 px-[clamp(12px,1.25vw,40px)] py-[clamp(4px,0.42vw,14px)] font-display text-[clamp(15px,1.25vw,38px)] uppercase tracking-[0.06em] backdrop-blur-[10px] ${
            toast.tone === 'on' ? 'border-on/60 text-on' : 'border-line text-ink'
          }`}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
