/**
 * Load-model helpers over 1 Hz power arrays: weighted power, intensity,
 * training load, and Banister-style fitness/fatigue/form curves.
 */

/** Form (fitness - fatigue) at or below which the dashboard suggests recovery. */
export const FORM_RECOVERY_THRESHOLD = -25;
/** Form at or above which the dashboard suggests adding load. */
export const FORM_RAMP_THRESHOLD = 15;

const WEIGHTED_WINDOW_S = 30;
const FITNESS_TAU_DAYS = 42;
const FATIGUE_TAU_DAYS = 7;

/**
 * Weighted power: 30 s trailing rolling average power over a 1 Hz array, mean
 * of 4th powers, then 4th root. The first 29 samples use their partial
 * window, so arrays shorter than 30 s still compute. Empty array -> 0.
 */
export function weightedPower(power1Hz: number[]): number {
  if (power1Hz.length === 0) return 0;

  let windowSum = 0;
  let fourthPowerSum = 0;
  for (let i = 0; i < power1Hz.length; i++) {
    windowSum += power1Hz[i]!;
    if (i >= WEIGHTED_WINDOW_S) windowSum -= power1Hz[i - WEIGHTED_WINDOW_S]!;
    const windowAvg = windowSum / Math.min(i + 1, WEIGHTED_WINDOW_S);
    fourthPowerSum += windowAvg ** 4;
  }

  return (fourthPowerSum / power1Hz.length) ** 0.25;
}

/**
 * Intensity as a fraction of FTP: wp / ftpW. A non-positive FTP yields 0
 * (no meaningful reference).
 */
export function intensity(wp: number, ftpW: number): number {
  return ftpW > 0 ? wp / ftpW : 0;
}

/**
 * Training load for a ride of durationS seconds at intensityVal:
 * hours * intensity^2 * 100.
 */
export function trainingLoad(durationS: number, intensityVal: number): number {
  return (durationS / 3600) * intensityVal ** 2 * 100;
}

/**
 * Fitness/fatigue/form curves over a daily load series. Each curve is an
 * exponentially weighted moving average:
 *   x[i] = x[i-1] + (load[i] - x[i-1]) * (1 - e^(-1/tau)),  x[-1] = 0
 * with tau = 42 days (fitness) and tau = 7 days (fatigue);
 * form[i] = fitness[i] - fatigue[i].
 * Same-day (yesterday-free) variant: a day's own load counts toward that
 * day's values, so form reflects the current day's ride immediately.
 */
export function fitnessFatigue(dailyLoads: number[]): {
  fitness: number[];
  fatigue: number[];
  form: number[];
} {
  const fitness: number[] = [];
  const fatigue: number[] = [];
  const form: number[] = [];

  const fitnessK = 1 - Math.exp(-1 / FITNESS_TAU_DAYS);
  const fatigueK = 1 - Math.exp(-1 / FATIGUE_TAU_DAYS);

  let fit = 0;
  let fat = 0;
  for (const load of dailyLoads) {
    fit += (load - fit) * fitnessK;
    fat += (load - fat) * fatigueK;
    fitness.push(fit);
    fatigue.push(fat);
    form.push(fit - fat);
  }

  return { fitness, fatigue, form };
}
