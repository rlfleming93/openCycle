/**
 * FTP estimators over 1 Hz power arrays.
 */

/** Power window (s) for the ramp-test estimate. */
const RAMP_WINDOW_S = 60;
/** Power window (s) for the 20-minute-test and history estimates. */
const TWENTY_MIN_WINDOW_S = 20 * 60;

/**
 * Maximum average power over any contiguous window of windowS samples
 * (O(n) sliding sum). A shorter array uses its whole-array average;
 * empty array or non-positive window -> 0.
 */
export function bestWindowAvg(power1Hz: number[], windowS: number): number {
  if (power1Hz.length === 0 || windowS <= 0) return 0;

  const n = power1Hz.length;
  if (n <= windowS) {
    let total = 0;
    for (const p of power1Hz) total += p;
    return total / n;
  }

  let sum = 0;
  for (let i = 0; i < windowS; i++) sum += power1Hz[i]!;
  let best = sum;
  for (let i = windowS; i < n; i++) {
    sum += power1Hz[i]! - power1Hz[i - windowS]!;
    if (sum > best) best = sum;
  }
  return best / windowS;
}

/** FTP from a ramp test: 0.75 x best 60 s average power. */
export function ftpFromRamp(power1Hz: number[]): number {
  return 0.75 * bestWindowAvg(power1Hz, RAMP_WINDOW_S);
}

/** FTP from a 20-minute test: 0.95 x best 20-minute average power. */
export function ftpFrom20Min(power1Hz: number[]): number {
  return 0.95 * bestWindowAvg(power1Hz, TWENTY_MIN_WINDOW_S);
}

/** One recorded ride's power data as used by ftpFromHistory. */
export interface ActivityWithPower {
  startedAt: string;
  power1Hz: number[] | null;
}

/**
 * FTP estimate from ride history: 0.95 x the best 20-minute average power
 * across qualifying activities from the last sinceMonths calendar months
 * (cutoff computed with Date#setMonth). Activities with null, empty, or
 * shorter-than-20-minute power data are skipped (a shorter array's
 * whole-array average would otherwise inflate the estimate). Rounded to the
 * nearest integer; null when no qualifying power data exists.
 */
export function ftpFromHistory(
  activities: ActivityWithPower[],
  sinceMonths = 6,
  now = new Date(),
): number | null {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - sinceMonths);

  let best = 0;
  for (const activity of activities) {
    const startedAt = new Date(activity.startedAt);
    if (Number.isNaN(startedAt.getTime()) || startedAt < cutoff) continue;
    if (activity.power1Hz === null || activity.power1Hz.length < TWENTY_MIN_WINDOW_S) continue;
    best = Math.max(best, bestWindowAvg(activity.power1Hz, TWENTY_MIN_WINDOW_S));
  }

  return best > 0 ? Math.round(0.95 * best) : null;
}
