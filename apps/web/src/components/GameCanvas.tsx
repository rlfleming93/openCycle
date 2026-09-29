import { useEffect, useRef } from 'react';

import { GameRenderer } from '../game/renderer.js';
import { useAppStore } from '../store.js';

import type { DestinationPoint } from './hud/DestinationMarker.js';

/**
 * Full-bleed background layer for RidePage: the three.js canvas sits at z-0
 * while the DOM HUD renders above it. Owns the renderer lifecycle — mounts
 * once per session, disposes everything on unmount (RAF, ResizeObserver,
 * geometries/materials/RTs, GL context; see GameRenderer.dispose).
 *
 * `onDestinationScreen` receives the projected destination point including the
 * disc radius in CSS px (see DestinationPoint); the HUD ring wraps that disc.
 */
export default function GameCanvas({
  onDestinationScreen,
}: {
  onDestinationScreen?: (point: DestinationPoint) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The renderer is created once; keep the latest hook without re-creating it.
  const hookRef = useRef(onDestinationScreen);

  useEffect(() => {
    hookRef.current = onDestinationScreen;
  }, [onDestinationScreen]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    const app = new GameRenderer(el, () => useAppStore.getState(), {
      onDestinationScreen: (point) => hookRef.current?.(point),
    });
    app.start();

    return () => {
      app.dispose();
    };
  }, []);

  return (
    <div className="absolute inset-0 z-0" aria-hidden="true">
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
