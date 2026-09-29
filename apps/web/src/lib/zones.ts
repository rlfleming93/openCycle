/**
 * Power-numeral color by ratio to the CURRENT target (LAW, round 2): on
 * 0.90–1.10 (in zone), over >1.10 (a training error, never a reward), dim
 * <0.90 (under target). Used only when a numeric target exists; free rides
 * (null target) fall back to the %FTP zone bands instead. Full literal
 * Tailwind classes so the scanner picks them up.
 */
export function targetRatioColor(ratio: number): string {
  if (ratio > 1.1) return 'text-over';
  if (ratio >= 0.9) return 'text-on';
  return 'text-dim';
}

/**
 * Power-zone color for a % of FTP value (TV-first dark theme):
 * <60 dim, 60–75 under, 76–90 on, 91–105 over, >105 danger.
 * Returns full literal Tailwind classes so Tailwind's scanner picks them up.
 */
export function zoneColor(pctOfFtp: number): string {
  if (pctOfFtp > 105) return 'text-danger';
  if (pctOfFtp >= 91) return 'text-over';
  if (pctOfFtp >= 76) return 'text-on';
  if (pctOfFtp >= 60) return 'text-under';
  return 'text-dim';
}

/**
 * Background variant of the same zone bands. Separate function with full
 * literal classes: Tailwind's scanner only generates classes it can see in
 * source — never compose `bg-` names at runtime from `text-` ones.
 */
export function zoneFill(pctOfFtp: number): string {
  if (pctOfFtp > 105) return 'bg-danger';
  if (pctOfFtp >= 91) return 'bg-over';
  if (pctOfFtp >= 76) return 'bg-on';
  if (pctOfFtp >= 60) return 'bg-under';
  return 'bg-dim';
}
