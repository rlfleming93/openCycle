import { FORM_RAMP_THRESHOLD, FORM_RECOVERY_THRESHOLD } from '@opencycle/shared';

import type { TrainingLoadResponse } from '../lib/api.js';

export type SuggestionTone = 'recovery' | 'ramp' | 'neutral';

export interface Suggestion {
  tone: SuggestionTone;
  text: string;
}

const TONE_CLASS: Record<SuggestionTone, string> = {
  recovery: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  ramp: 'border-on/40 bg-on/10 text-on',
  neutral: 'border-line bg-panel text-ink/90',
};

/**
 * Weekly suggestion from the Banister curves (shared thresholds):
 * form below FORM_RECOVERY_THRESHOLD -> recovery day; form above
 * FORM_RAMP_THRESHOLD with a flat last-7-days fitness (delta < 1) -> add
 * load; otherwise a neutral summary of the current values.
 */
export function suggest(load: TrainingLoadResponse): Suggestion {
  const idx = load.form.length - 1;
  if (idx < 0) {
    return { tone: 'neutral', text: 'No training data yet — your first rides will seed the curves.' };
  }
  const fitness = load.fitness[idx] ?? 0;
  const fatigue = load.fatigue[idx] ?? 0;
  const form = load.form[idx] ?? 0;
  // Fitness delta over the trailing 7 days; pre-history counts as 0 (the
  // EWMA series starts at 0), so short histories read as flat.
  const fitnessDelta = fitness - (idx >= 7 ? (load.fitness[idx - 7] ?? 0) : 0);

  if (form < FORM_RECOVERY_THRESHOLD) {
    return { tone: 'recovery', text: 'Fatigue is high — take a recovery day' };
  }
  if (form > FORM_RAMP_THRESHOLD && fitnessDelta < 1) {
    return { tone: 'ramp', text: 'You are fresh — time to add load' };
  }
  return {
    tone: 'neutral',
    text: `Fitness ${fitness.toFixed(0)} · Fatigue ${fatigue.toFixed(0)} · Form ${form.toFixed(0)} — steady progress`,
  };
}

/** Banner summarizing the weekly training suggestion for one rider/all riders. */
export default function SuggestionBanner({ load }: { load: TrainingLoadResponse }) {
  const suggestion = suggest(load);
  return (
    <div className={`rounded-[14px] border px-4 py-3 text-sm font-medium ${TONE_CLASS[suggestion.tone]}`}>
      {suggestion.text}
    </div>
  );
}
