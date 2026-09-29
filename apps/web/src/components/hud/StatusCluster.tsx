import { useEffect, useState } from 'react';

import type { SessionEvent } from '@opencycle/shared';

import { fmtClock } from '../../game/hud.js';
import { useAppStore, type AppState } from '../../store.js';

const ZONE_WINDOW_MS = 35_000;

const WS_LABEL: Record<AppState['wsStatus'], { dot: string; label: string }> = {
  open: { dot: 'bg-on', label: 'Connected' },
  connecting: { dot: 'bg-over animate-pulse', label: 'Connecting' },
  closed: { dot: 'bg-danger', label: 'Disconnected' },
};

/** events are capped newest-last — scan backwards for the latest bothInZone. */
function lastBothInZone(events: SessionEvent[]): Extract<SessionEvent, { kind: 'bothInZone' }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event !== undefined && event.kind === 'bothInZone') return event;
  }
  return undefined;
}

/**
 * Top-left status: server-authoritative elapsed, the connection, and the
 * multi-rider SYNC chip (the same 35 s in-zone window the server scores
 * beacons with).
 */
export default function StatusCluster() {
  const session = useAppStore((state) => state.session);
  const events = useAppStore((state) => state.events);
  const wsStatus = useAppStore((state) => state.wsStatus);
  const latest = useAppStore((state) => state.latest);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (session === null) return null;

  // Server-authoritative elapsed: the newest telemetry ts across riders minus
  // the session start; the client clock only covers the first sample gap.
  let latestTs = 0;
  for (const sample of Object.values(latest)) {
    if (sample !== undefined && sample.ts > latestTs) latestTs = sample.ts;
  }
  const elapsedS = Math.max(0, (latestTs > 0 ? latestTs : now) - session.startedAt) / 1000;

  // In-zone is an in-workout signal: with every target cleared (workouts
  // finished / free ride) a stale streak must not keep the chip lit. Both-in-
  // zone is co-op, so a solo session can never earn it.
  const hasTarget = session.riders.some((rider) => rider.targetW !== null && rider.targetW > 0);
  const streak = lastBothInZone(events);
  const synced = hasTarget && streak !== undefined && now - streak.ts <= ZONE_WINDOW_MS;
  const multiRider = session.riders.length >= 2;
  const ws = WS_LABEL[wsStatus];

  return (
    <div className="pointer-events-none absolute left-[clamp(12px,1.35vw,44px)] top-[clamp(16px,1.77vw,56px)] z-30 flex flex-col items-start gap-[clamp(3px,0.31vw,10px)] font-display uppercase tracking-[0.06em]">
      <span className="text-[clamp(15px,1.25vw,38px)] text-dim">
        Elapsed <span className="font-semibold tabular-nums text-ink">{fmtClock(elapsedS)}</span>
      </span>
      <span className="flex items-center gap-[clamp(4px,0.42vw,14px)] rounded-full border border-line bg-void/50 px-[clamp(8px,0.83vw,26px)] py-[clamp(2px,0.21vw,8px)] text-[clamp(12px,0.94vw,28px)] text-dim backdrop-blur-[10px]">
        <span aria-hidden="true" className={`h-[clamp(5px,0.52vw,16px)] w-[clamp(5px,0.52vw,16px)] rounded-full ${ws.dot}`} />
        {ws.label}
      </span>
      {multiRider && (
        <span
          className={`rounded-full border px-[clamp(8px,0.83vw,26px)] py-[clamp(2px,0.21vw,8px)] text-[clamp(12px,0.94vw,28px)] backdrop-blur-[10px] ${
            synced ? 'border-on/50 bg-on/10 text-on' : 'border-line bg-void/50 text-dim'
          }`}
        >
          Sync{' '}
          <span className="font-semibold tabular-nums">
            {synced && streak !== undefined ? fmtClock(streak.streakS) : '—'}
          </span>
        </span>
      )}
    </div>
  );
}
