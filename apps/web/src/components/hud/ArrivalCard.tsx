import { useEffect, useMemo, useRef, useState } from 'react';

import { arrivalChip, honorRoll, objectiveLegCount } from '../../game/hud.js';
import { useAppStore } from '../../store.js';

/** How long the full arrival card stays up before it becomes a chip. */
const COLLAPSE_MS = 20_000;

/**
 * Arrival: the destination reached, the surveys it revealed, and the co-op
 * honors. Shown on the first workoutCompleted of the session; after 20 s it
 * collapses to a top chip until the session ends.
 */
export default function ArrivalCard() {
  const session = useAppStore((state) => state.session);
  const events = useAppStore((state) => state.events);
  const [now, setNow] = useState(() => Date.now());
  const finisherIdsRef = useRef<string[]>([]);

  // First arrival of this session, latched: events are newest-last, capped,
  // and cleared with the session, so the earliest workoutCompleted wins and is
  // remembered even after the cap evicts it.
  const firstArrivalTs = useMemo(() => {
    for (const event of events) {
      if (event.kind === 'workoutCompleted') return event.ts;
    }
    return null;
  }, [events]);
  const arrivedAtRef = useRef<number | null>(null);
  if (arrivedAtRef.current === null && firstArrivalTs !== null) arrivedAtRef.current = firstArrivalTs;
  const arrivedAt = arrivedAtRef.current;
  const collapsed = arrivedAt !== null && now - arrivedAt >= COLLAPSE_MS;

  useEffect(() => {
    if (arrivedAt === null || collapsed) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [arrivedAt, collapsed]);

  if (session === null || session.destination === null || arrivedAt === null) return null;

  const destination = session.destination;
  const multiRider = session.riders.length > 1;
  // Finishers are latched as they arrive: a later event-cap eviction must not
  // drop a finisher's survey line from the card.
  for (const event of events) {
    if (event.kind === 'workoutCompleted' && !finisherIdsRef.current.includes(event.riderId)) {
      finisherIdsRef.current.push(event.riderId);
    }
  }
  const finisherIds = finisherIdsRef.current;
  const honors = honorRoll(session, events);

  if (collapsed) {
    const lead = session.riders.find((rider) => rider.riderId === destination.leadRiderId) ?? session.riders[0];
    const clean = lead?.surveysClean ?? 0;
    const total = objectiveLegCount(lead?.legs ?? null);
    // Top-right, under the route strip: the destination planet takes the
    // centre of the frame through the arrival orbit.
    return (
      <div className="pointer-events-none absolute right-[clamp(12px,1.35vw,44px)] top-[17%] z-30 flex justify-end">
        <div className="animate-toast-in rounded-full border border-on/50 bg-void/75 px-[clamp(12px,1.25vw,40px)] py-[clamp(3px,0.31vw,12px)] font-display text-[clamp(15px,1.25vw,38px)] uppercase tracking-[0.06em] text-on backdrop-blur-[10px]">
          {arrivalChip(destination.name, clean, total)}
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="animate-arrival-in pointer-events-none absolute left-1/2 top-1/2 z-30 w-[min(46vw,760px)] rounded-[14px] border border-line bg-void/80 px-[clamp(18px,2vw,72px)] py-[clamp(16px,1.7vw,64px)] text-center backdrop-blur-[10px]"
    >
      <p className="font-display text-[clamp(24px,2.5vw,88px)] font-bold uppercase tracking-[0.06em] text-ink">
        ARRIVED · <span className="text-on">{destination.name}</span>
      </p>
      <div className="mt-[clamp(8px,0.83vw,28px)] flex flex-col gap-[clamp(2px,0.21vw,8px)] font-display text-[clamp(16px,1.354vw,44px)] uppercase tracking-[0.06em] text-ink">
        {finisherIds.map((riderId) => {
          const rider = session.riders.find((r) => r.riderId === riderId);
          if (rider === undefined) return null;
          return (
            <p key={riderId}>
              {multiRider && <span className="text-dim">{rider.name} · </span>}
              Surveyed {rider.surveysClean} of {objectiveLegCount(rider.legs)}
            </p>
          );
        })}
      </div>
      <p className="mt-[clamp(4px,0.42vw,16px)] font-display text-[clamp(15px,1.25vw,38px)] uppercase tracking-[0.06em] text-dim">
        System {destination.voyageIndex + 1} of your voyage
      </p>
      {honors.length > 0 && (
        <div className="mt-[clamp(8px,0.83vw,28px)] border-t border-line pt-[clamp(6px,0.62vw,22px)] font-display text-[clamp(14px,1.15vw,34px)] uppercase tracking-[0.06em] text-over">
          {honors.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
