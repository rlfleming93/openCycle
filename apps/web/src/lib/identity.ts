/**
 * Rider identity hues (ship accents, plumes, HUD marks). Deliberately separate
 * from the zone palette (blue/emerald/amber/red/zinc): identity marks WHO,
 * zone colors mark HOW the ride is going. Index-based — rider 0 blue, 1
 * coral, 2 gold, 3 teal, then the list cycles. Slots 0/1 are the
 * high-contrast pair (blue vs coral reads clearly at 3 m); gold and teal are
 * the 2/3 fallbacks.
 */
export const IDENTITY_COLORS = ['#5b8cff', '#ff7a6b', '#f5c542', '#4fd1c5'] as const;

export function identityColor(index: number): string {
  return IDENTITY_COLORS[index % IDENTITY_COLORS.length] ?? IDENTITY_COLORS[0];
}
