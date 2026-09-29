import { useState } from 'react';
import type { FormEvent } from 'react';

import { RiderProfileSchema, type RiderProfile } from '@opencycle/shared';

import { createProfile, updateProfile } from '../lib/api.js';

const ProfileInputSchema = RiderProfileSchema.omit({ id: true });

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  ftpW: 'FTP',
  weightKg: 'Weight',
  restingHr: 'Resting HR',
  maxHr: 'Max HR',
  'garmin.email': 'Garmin email',
};

const inputClass =
  'w-full rounded-[8px] border border-line bg-deep px-3 py-2 text-ink placeholder:text-dim/70 focus:border-on focus:outline-none';

interface ProfileFormProps {
  /** Existing profile when editing; omit for create. */
  initial?: RiderProfile;
  /** Called with the saved profile after the mutation succeeds. */
  onSaved: (profile: RiderProfile) => void;
  onCancel?: () => void;
}

interface FormValues {
  name: string;
  ftpW: string;
  weightKg: string;
  restingHr: string;
  maxHr: string;
  garminEmail: string;
}

type ValidationResult =
  | { ok: true; value: Omit<RiderProfile, 'id'> }
  | { ok: false; error: string };

function initialValues(initial?: RiderProfile): FormValues {
  return {
    name: initial?.name ?? '',
    ftpW: initial === undefined ? '' : String(initial.ftpW),
    weightKg: initial === undefined ? '' : String(initial.weightKg),
    restingHr: initial?.restingHr === undefined ? '' : String(initial.restingHr),
    maxHr: initial?.maxHr === undefined ? '' : String(initial.maxHr),
    garminEmail: initial?.garmin?.email ?? '',
  };
}

function validate(values: FormValues): ValidationResult {
  if (values.name.trim() === '') return { ok: false, error: 'Name is required' };
  if (values.ftpW.trim() === '') return { ok: false, error: 'FTP is required' };
  if (values.weightKg.trim() === '') return { ok: false, error: 'Weight is required' };
  const candidate = {
    name: values.name.trim(),
    ftpW: Number(values.ftpW),
    weightKg: Number(values.weightKg),
    ...(values.restingHr.trim() === '' ? {} : { restingHr: Number(values.restingHr) }),
    ...(values.maxHr.trim() === '' ? {} : { maxHr: Number(values.maxHr) }),
    ...(values.garminEmail.trim() === '' ? {} : { garmin: { email: values.garminEmail.trim() } }),
  };
  const parsed = ProfileInputSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  if (issue === undefined) return { ok: false, error: 'Invalid profile' };
  const path = issue.path.join('.');
  return { ok: false, error: `${FIELD_LABELS[path] ?? (path === '' ? 'Profile' : path)}: ${issue.message}` };
}

export default function ProfileForm({ initial, onSaved, onCancel }: ProfileFormProps) {
  const [values, setValues] = useState<FormValues>(() => initialValues(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function setField(field: keyof FormValues, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const result = validate(values);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSubmitting(true);
    try {
      const saved =
        initial === undefined ? await createProfile(result.value) : await updateProfile(initial.id, result.value);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm text-dim">Name</span>
          <input
            className={inputClass}
            value={values.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="e.g. Ryan"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-dim">FTP (W)</span>
          <input
            className={inputClass}
            type="number"
            min={50}
            max={600}
            step={1}
            value={values.ftpW}
            onChange={(e) => setField('ftpW', e.target.value)}
            placeholder="250"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-dim">Weight (kg)</span>
          <input
            className={inputClass}
            type="number"
            min={30}
            max={200}
            step={0.5}
            value={values.weightKg}
            onChange={(e) => setField('weightKg', e.target.value)}
            placeholder="75"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-dim">Resting HR (optional)</span>
          <input
            className={inputClass}
            type="number"
            min={25}
            max={100}
            step={1}
            value={values.restingHr}
            onChange={(e) => setField('restingHr', e.target.value)}
            placeholder="48"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-dim">Max HR (optional)</span>
          <input
            className={inputClass}
            type="number"
            min={120}
            max={230}
            step={1}
            value={values.maxHr}
            onChange={(e) => setField('maxHr', e.target.value)}
            placeholder="186"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-dim">Garmin email (optional)</span>
          <input
            className={inputClass}
            type="email"
            value={values.garminEmail}
            onChange={(e) => setField('garminEmail', e.target.value)}
            placeholder="rider@example.com"
          />
        </label>
      </div>

      {error !== null && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-[8px] bg-on px-4 py-2 font-medium text-void hover:bg-on/85 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : initial === undefined ? 'Create profile' : 'Save changes'}
        </button>
        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[8px] border border-line px-4 py-2 text-ink/90 hover:bg-ink/5"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
