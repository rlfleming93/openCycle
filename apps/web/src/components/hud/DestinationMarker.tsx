import { useEffect, useRef } from 'react';

import type { SessionDestination } from '@opencycle/shared';

import { useAppStore } from '../../store.js';

/**
 * Screen-space point of the destination, in CSS pixels from the canvas
 * top-left. `r` is the projected radius of the destination disc; the marker
 * ring wraps it and the label hangs below, so neither ever covers the planet.
 */
export interface DestinationPoint {
  x: number;
  y: number;
  visible: boolean;
  /** Projected destination disc radius in CSS px. */
  r: number;
}

/** Ring floor when the destination is a speck, and the gap above the disc. */
const MIN_RING_RADIUS = 22;
const RING_PADDING = 10;
/** Gap between the ring's bottom edge and the label. */
const LABEL_GAP = 8;

/**
 * Ring + name pinned to the destination's projected position. The renderer
 * writes the point into a ref every frame; this component reads it in its own
 * RAF loop and writes style.transform plus the ring size directly — no React
 * state per frame, so a growing planet never re-renders the HUD.
 */
export default function DestinationMarker({
  point,
  destination,
  pct,
}: {
  point: { current: DestinationPoint | null };
  destination: SessionDestination | null;
  pct: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const events = useAppStore((state) => state.events);
  // Latched: from the lead rider's arrival onward the fleet is at the planet,
  // so the ring and label would sit on top of it.
  const arrivedRef = useRef(false);
  if (
    destination !== null &&
    !arrivedRef.current &&
    events.some((event) => event.kind === 'workoutCompleted' && event.riderId === destination.leadRiderId)
  ) {
    arrivedRef.current = true;
  }

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const root = rootRef.current;
      const ring = ringRef.current;
      const label = labelRef.current;
      const p = point.current;
      if (root !== null && ring !== null && label !== null) {
        if (p === null || !p.visible) {
          root.style.opacity = '0';
        } else {
          const discRadius = Number.isFinite(p.r) ? p.r : 0;
          const ringRadius = Math.max(MIN_RING_RADIUS, discRadius + RING_PADDING);
          root.style.opacity = '1';
          root.style.transform = `translate(${p.x}px, ${p.y}px)`;
          ring.style.width = `${ringRadius * 2}px`;
          ring.style.height = `${ringRadius * 2}px`;
          label.style.top = `${ringRadius + LABEL_GAP}px`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [point]);

  if (destination === null || arrivedRef.current) return null;

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-20 opacity-0 transition-opacity duration-200"
    >
      <div
        ref={ringRef}
        className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-over/80 shadow-[0_0_18px_rgba(255,190,120,0.35)]"
      />
      <div
        ref={labelRef}
        className="absolute left-0 -translate-x-1/2 whitespace-nowrap font-display text-[clamp(14px,1.146vw,34px)] uppercase tracking-[0.06em] text-over"
      >
        {destination.name} <span className="text-dim">· {Math.round(pct * 100)}%</span>
      </div>
    </div>
  );
}
