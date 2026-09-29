import { useCallback, useEffect, useRef, useState } from 'react';

import GameCanvas from '../components/GameCanvas.js';
import MediaPanel from '../components/MediaPanel.js';
import RiderColumn from '../components/RiderColumn.js';
import ArrivalCard from '../components/hud/ArrivalCard.js';
import ControlsTray from '../components/hud/ControlsTray.js';
import DestinationMarker, { type DestinationPoint } from '../components/hud/DestinationMarker.js';
import LegToast from '../components/hud/LegToast.js';
import RiderCard from '../components/hud/RiderCard.js';
import RouteStrip from '../components/hud/RouteStrip.js';
import StatusCluster from '../components/hud/StatusCluster.js';
import WorkoutSidebar from '../components/hud/WorkoutSidebar.js';
import { rawGameProgress } from '../game/director.js';
import { useAppStore } from '../store.js';

/** How long the transient server-error banner stays up before auto-dismiss. */
const ERROR_BANNER_MS = 8000;

/**
 * Full-screen ride page (the nav is hidden by the router while a session
 * runs). Pure store-driven render: no fetches — everything comes from the
 * WS-fed zustand store.
 *
 * Space game on: the three.js canvas is the whole background (z-0) with a
 * light top-and-bottom scrim, and the DOM HUD layers above it — the flight plan
 * in the top ~11%, the workout sidebar down the left band, rider cards in the
 * bottom ~28%, so the destination stays clear in the upper-middle third. Off:
 * the plain per-rider dashboard. Both modes share the status cluster, the
 * controls tray and the media panel.
 */
export default function RidePage() {
  const session = useAppStore((s) => s.session);
  const lastError = useAppStore((s) => s.lastError);
  const spaceGame = useAppStore((s) => s.spaceGame);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);
  // Destination screen point, written by the renderer hook every frame and
  // read by DestinationMarker's own RAF loop (never React state).
  const destinationPoint = useRef<DestinationPoint | null>(null);
  const lastProgress = useRef(-1);

  // Re-arm the auto-dismiss timer for every new server error frame.
  useEffect(() => {
    if (lastError === null) return;
    setErrorDismissed(false);
    const id = window.setTimeout(() => setErrorDismissed(true), ERROR_BANNER_MS);
    return () => window.clearTimeout(id);
  }, [lastError]);

  const onDestinationScreen = useCallback((point: DestinationPoint) => {
    destinationPoint.current = point;
  }, []);

  if (session === null) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-void text-3xl text-dim">
        No active session.
      </div>
    );
  }

  const rawProgress = rawGameProgress(session);
  if (rawProgress !== null) lastProgress.current = Math.max(lastProgress.current, rawProgress);
  const progress = lastProgress.current < 0 ? 0.5 : Math.min(1, Math.max(0, lastProgress.current));
  const riderCount = session.riders.length;

  if (!spaceGame) {
    return (
      <div className="relative flex h-screen w-screen flex-col bg-void text-ink">
        {lastError !== null && !errorDismissed && (
          <ErrorBanner message={lastError} onDismiss={() => setErrorDismissed(true)} />
        )}
        <div
          className="grid min-h-0 flex-1 gap-px bg-line"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, riderCount)}, minmax(0, 1fr))` }}
        >
          {session.riders.map((rider, index) => (
            <RiderColumn key={rider.riderId} rider={rider} riderIndex={index} />
          ))}
        </div>
        <StatusCluster />
        <ControlsTray session={session} onOpenMedia={() => setMediaOpen(true)} />
        <MediaPanel open={mediaOpen} onClose={() => setMediaOpen(false)} />
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-void text-ink">
      {lastError !== null && !errorDismissed && (
        <ErrorBanner message={lastError} onDismiss={() => setErrorDismissed(true)} />
      )}

      <GameCanvas onDestinationScreen={onDestinationScreen} />

      {/* HUD contrast floor: top and bottom scrims behind the DOM HUD. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-[18vh] bg-gradient-to-b from-void/80 to-transparent"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-[30vh] bg-gradient-to-t from-void/80 to-transparent"
      />

      <RouteStrip />
      <DestinationMarker point={destinationPoint} destination={session.destination} pct={progress} />
      {/* After the marker: the sidebar owns the left band, so its panel paints
          over the destination ring wherever the two meet. */}
      <WorkoutSidebar />
      <LegToast />
      <ArrivalCard />

      {riderCount <= 2 && (
        <div data-rider-card-band className="pointer-events-none absolute bottom-[clamp(28px,2.08vw,72px)] left-[clamp(14px,2.08vw,72px)] z-20 w-[clamp(320px,27.08vw,880px)]">
          <RiderCard rider={session.riders[0]!} riderIndex={0} />
        </div>
      )}
      {riderCount === 2 && (
        <div data-rider-card-band className="pointer-events-none absolute bottom-[clamp(28px,2.08vw,72px)] right-[clamp(14px,2.08vw,72px)] z-20 w-[clamp(320px,27.08vw,880px)]">
          <RiderCard rider={session.riders[1]!} riderIndex={1} />
        </div>
      )}
      {riderCount >= 3 && (
        <div
          data-rider-card-band
          className="pointer-events-none absolute inset-x-[clamp(12px,1.35vw,48px)] bottom-[clamp(44px,4.4vw,150px)] z-20 grid gap-[clamp(8px,1.04vw,32px)]"
          style={{ gridTemplateColumns: `repeat(${riderCount}, minmax(0, 1fr))` }}
        >
          {session.riders.map((rider, index) => (
            <RiderCard key={rider.riderId} rider={rider} riderIndex={index} />
          ))}
        </div>
      )}

      <StatusCluster />
      <ControlsTray session={session} onOpenMedia={() => setMediaOpen(true)} />
      <MediaPanel open={mediaOpen} onClose={() => setMediaOpen(false)} />
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="absolute inset-x-0 top-0 z-40 flex items-center justify-between gap-4 bg-danger px-6 py-3 text-2xl font-semibold text-void">
      <span className="min-w-0 truncate">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-[8px] border border-void/40 px-4 py-1 text-xl font-bold text-void hover:bg-void/10"
      >
        Dismiss
      </button>
    </div>
  );
}
