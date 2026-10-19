import { useState } from 'react';
import type { FormEvent } from 'react';

import { RiderProfileSchema, type RiderProfile } from '@opencycle/shared';

import { assignDevice, createProfile, updateProfile, type ListedDevice } from '../lib/api.js';

const ProfileInputSchema = RiderProfileSchema.omit({ id: true });

const KG_PER_LB = 0.45359237;

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
  devices: ListedDevice[];
  /** Called with the saved profile after the mutation succeeds. */
  onSaved: (profile: RiderProfile) => void;
  onCancel?: () => void;
  /** Limit the form to the fields needed during first-run setup. */
  riderOnly?: boolean;
  submitLabel?: string;
  cancelLabel?: string;
}

interface FormValues {
  name: string;
  ftpW: string;
  weight: string;
  weightUnit: 'kg' | 'lb';
  restingHr: string;
  maxHr: string;
  garminEmail: string;
  trainerId: string;
  hrmId: string;
}

type ValidationResult =
  | { ok: true; value: Omit<RiderProfile, 'id'> }
  | { ok: false; error: string };

function initialValues(initial: RiderProfile | undefined, devices: ListedDevice[]): FormValues {
  return {
    name: initial?.name ?? '',
    ftpW: initial === undefined ? '' : String(initial.ftpW),
    weight: initial === undefined ? '' : String(initial.weightKg),
    weightUnit: 'kg',
    restingHr: initial?.restingHr === undefined ? '' : String(initial.restingHr),
    maxHr: initial?.maxHr === undefined ? '' : String(initial.maxHr),
    garminEmail: initial?.garmin?.email ?? '',
    trainerId:
      initial === undefined
        ? ''
        : (devices.find((device) => device.kind === 'trainer' && device.riderId === initial.id)?.id ?? ''),
    hrmId:
      initial === undefined
        ? ''
        : (devices.find((device) => device.kind === 'hrm' && device.riderId === initial.id)?.id ?? ''),
  };
}

function validate(values: FormValues): ValidationResult {
  if (values.name.trim() === '') return { ok: false, error: 'Name is required' };
  if (values.ftpW.trim() === '') return { ok: false, error: 'FTP is required' };
  if (values.weight.trim() === '') return { ok: false, error: 'Weight is required' };
  const weight = Number(values.weight);
  const candidate = {
    name: values.name.trim(),
    ftpW: Number(values.ftpW),
    weightKg: values.weightUnit === 'lb' ? Math.round(weight * KG_PER_LB * 10) / 10 : weight,
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

export default function ProfileForm({
  initial,
  devices,
  onSaved,
  onCancel,
  riderOnly = false,
  submitLabel,
  cancelLabel = 'Cancel',
}: ProfileFormProps) {
  const [values, setValues] = useState<FormValues>(() => initialValues(initial, devices));
  const [createdProfile, setCreatedProfile] = useState<RiderProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function setField(field: keyof FormValues, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
  }

  /** Switch units and convert the typed number so the weight itself does not change. */
  function setWeightUnit(unit: 'kg' | 'lb') {
    setValues((v) => {
      if (unit === v.weightUnit) return v;
      const n = Number(v.weight);
      if (v.weight.trim() === '' || !Number.isFinite(n)) return { ...v, weightUnit: unit };
      // Pounds as whole numbers, kilograms to 0.1, so kg -> lb -> kg does not drift.
      const converted = unit === 'lb' ? Math.round(n / KG_PER_LB) : Math.round(n * KG_PER_LB * 10) / 10;
      return { ...v, weightUnit: unit, weight: String(converted) };
    });
  }

  async function saveDeviceAssignments(profileId: string) {
    const selections = [
      { kind: 'trainer' as const, deviceId: values.trainerId },
      { kind: 'hrm' as const, deviceId: values.hrmId },
    ];
    const updates: Array<Promise<ListedDevice>> = [];
    for (const selection of selections) {
      const previous =
        initial === undefined
          ? undefined
          : devices.find((device) => device.kind === selection.kind && device.riderId === initial.id);
      if (previous !== undefined && previous.id !== selection.deviceId) {
        updates.push(assignDevice(previous.id, null));
      }
      if (selection.deviceId !== '' && previous?.id !== selection.deviceId) {
        updates.push(assignDevice(selection.deviceId, profileId));
      }
    }
    await Promise.all(updates);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const result = validate(values);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The form has no auto-upload switch; keep the saved setting while the Garmin email stays.
    const autoUpload = initial?.garmin?.autoUpload;
    const value =
      autoUpload !== undefined && result.value.garmin !== undefined
        ? { ...result.value, garmin: { ...result.value.garmin, autoUpload } }
        : result.value;
    setSubmitting(true);
    try {
      const existing = initial ?? createdProfile;
      const saved =
        existing === null ? await createProfile(value) : await updateProfile(existing.id, value);
      if (initial === undefined && createdProfile === null) setCreatedProfile(saved);
      await saveDeviceAssignments(saved.id);
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
          <p className="mt-1 text-xs text-dim">
            Not sure? Start at 2.5 W per kg; you can change it later.
          </p>
        </label>
        <div className="block">
          <span className="mb-1 block text-sm text-dim">Weight</span>
          <div className="flex gap-2">
            <input
              className={inputClass}
              type="number"
              aria-label="Weight"
              min={values.weightUnit === 'lb' ? 66 : 30}
              max={values.weightUnit === 'lb' ? 440 : 200}
              step={values.weightUnit === 'lb' ? 1 : 0.5}
              value={values.weight}
              onChange={(e) => setField('weight', e.target.value)}
              placeholder={values.weightUnit === 'lb' ? '165' : '75'}
            />
            <select
              className="rounded-[8px] border border-line bg-deep px-2 py-2 text-ink focus:border-on focus:outline-none"
              aria-label="Weight unit"
              value={values.weightUnit}
              onChange={(e) => setWeightUnit(e.target.value as 'kg' | 'lb')}
            >
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </div>
        </div>
        {!riderOnly && (
          <>
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
              <span className="mb-1 block text-sm text-dim">My trainer</span>
              <select
                className={inputClass}
                value={values.trainerId}
                onChange={(e) => setField('trainerId', e.target.value)}
              >
                <option value="">None</option>
                {devices
                  .filter((device) => device.kind === 'trainer')
                  .map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name === '' ? 'Unnamed trainer' : device.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-dim">My heart rate strap</span>
              <select
                className={inputClass}
                value={values.hrmId}
                onChange={(e) => setField('hrmId', e.target.value)}
              >
                <option value="">None</option>
                {devices
                  .filter((device) => device.kind === 'hrm')
                  .map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name === '' ? 'Unnamed strap' : device.name}
                    </option>
                  ))}
              </select>
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
          </>
        )}
      </div>

      {error !== null && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-[8px] bg-on px-4 py-2 font-medium text-void hover:bg-on/85 disabled:opacity-50"
        >
          {submitting
            ? 'Saving…'
            : (submitLabel ?? (initial === undefined ? 'Create profile' : 'Save changes'))}
        </button>
        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[8px] border border-line px-4 py-2 text-ink/90 hover:bg-ink/5"
          >
            {cancelLabel}
          </button>
        )}
      </div>
    </form>
  );
}
