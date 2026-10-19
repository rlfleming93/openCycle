import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type {
  AdapterState,
  DeviceKind,
  DeviceSample,
  RiderProfile,
} from '@opencycle/shared';

import { BluetoothFix } from '../components/BluetoothBanner.js';
import GarminConnect from '../components/GarminConnect.js';
import ProfileForm from '../components/ProfileForm.js';
import { CadenceDial } from '../components/hud/CadenceDial.js';
import {
  assignDevice,
  getBleState,
  labelDevice,
  listDevices,
  type ListedDevice,
} from '../lib/api.js';
import { useAppStore } from '../store.js';

const STEPS = ['Bluetooth', 'Rider', 'Trainer', 'Heart rate'] as const;
const inputClass =
  'w-full rounded-[8px] border border-line bg-deep px-3 py-2 text-ink focus:border-on focus:outline-none';

interface DeviceStepProps {
  kind: DeviceKind;
  profile: RiderProfile;
  devices: ListedDevice[];
  selectedId: string | null;
  discoveryError: string | null;
  onSelected: (id: string) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip?: () => void;
}

function WizardProgress({ step }: { step: number }) {
  return (
    <ol
      aria-label="Setup progress"
      className="grid grid-cols-4 gap-2 border-b border-line pb-5"
    >
      {STEPS.map((label, index) => {
        const reached = step >= index;
        return (
          <li
            key={label}
            aria-current={step === index ? 'step' : undefined}
            className="min-w-0"
          >
            <div className="flex items-center gap-2">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-display text-sm font-semibold ${
                  reached ? 'border-on bg-on text-void' : 'border-line text-dim'
                }`}
              >
                {index + 1}
              </span>
              <span
                className={`truncate text-xs sm:text-sm ${reached ? 'text-ink' : 'text-dim'}`}
              >
                {label}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function BluetoothStep({
  state,
  onNext,
}: {
  state: AdapterState;
  onNext: () => void;
}) {
  const ready = state === 'poweredOn' || state === 'disabled';
  const problem = state === 'unauthorized' || state === 'poweredOff';
  const waiting = state === 'unknown' || state === 'resetting';

  return (
    <section>
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">
        Connect Bluetooth
      </h1>
      <p className="mt-2 text-dim">
        openCycle uses Bluetooth for trainers and heart rate straps.
      </p>
      <div
        className={`mt-6 rounded-[14px] border p-5 ${
          ready ? 'border-on/40 bg-on/10' : 'border-line bg-deep'
        }`}
      >
        {state === 'poweredOn' && (
          <p className="flex items-center gap-3 font-medium text-on">
            <svg aria-hidden="true" className="h-6 w-6" fill="none" viewBox="0 0 24 24">
              <path
                d="m5 12 4 4L19 6"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.5"
              />
            </svg>
            Bluetooth is ready
          </p>
        )}
        {state === 'disabled' && (
          <p className="text-under">
            Bluetooth scanning is disabled. openCycle is running in simulator mode.
          </p>
        )}
        {problem && (
          <p className="text-over">
            <BluetoothFix state={state} />
          </p>
        )}
        {state === 'unsupported' && (
          <p className="text-danger">This Mac does not support Bluetooth Low Energy.</p>
        )}
        {waiting && (
          <p className="animate-pulse text-dim">Checking the Bluetooth adapter…</p>
        )}
      </div>
      <div className="mt-8 flex justify-end">
        <button
          type="button"
          disabled={!ready}
          onClick={onNext}
          className="rounded-[8px] bg-on px-5 py-2 font-medium text-void hover:bg-on/85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </section>
  );
}

function RiderStep({
  profile,
  onSaved,
  onBack,
}: {
  profile: RiderProfile | null;
  onSaved: (profile: RiderProfile) => void;
  onBack: () => void;
}) {
  return (
    <section>
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">
        Set up your rider
      </h1>
      <p className="mb-6 mt-2 text-dim">These details set your training targets.</p>
      <ProfileForm
        initial={profile ?? undefined}
        devices={[]}
        riderOnly
        submitLabel="Next"
        cancelLabel="Back"
        onSaved={onSaved}
        onCancel={onBack}
      />
    </section>
  );
}

function DeviceStatusBadge({ status }: { status: string | undefined }) {
  const connected = status === 'connected' || status === 'controlAcquired';
  const failed = status === 'error' || status === 'disconnected' || status === 'controlLost';
  const className = connected
    ? 'border-on/40 bg-on/10 text-on'
    : failed
      ? 'border-danger/40 bg-danger/10 text-danger'
      : status === 'connecting'
        ? 'border-under/40 bg-under/10 text-under'
        : 'border-line text-dim';
  const label = connected
    ? 'Connected'
    : failed
      ? status === 'error'
        ? 'Error'
        : 'Disconnected'
      : status === 'connecting'
        ? 'Connecting'
        : 'Found';
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${className}`}>{label}</span>;
}

function DeviceChoices({
  devices,
  selectedId,
  busyId,
  onSelect,
}: {
  devices: ListedDevice[];
  selectedId: string | null;
  busyId: string | null;
  onSelect: (device: ListedDevice) => void;
}) {
  const deviceStatus = useAppStore((state) => state.deviceStatus);
  const deviceStatusMessage = useAppStore((state) => state.deviceStatusMessage);

  if (devices.length === 0) {
    return (
      <p className="rounded-[8px] border border-dashed border-line px-4 py-6 text-center text-dim">
        Scanning for devices…
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {devices.map((device) => (
        <button
          key={device.id}
          type="button"
          aria-pressed={selectedId === device.id}
          disabled={busyId !== null}
          onClick={() => onSelect(device)}
          className={`rounded-[14px] border p-4 text-left transition-colors disabled:opacity-50 ${
            selectedId === device.id ? 'border-on bg-on/10' : 'border-line bg-deep hover:border-on/50'
          }`}
        >
          <span className="flex items-center justify-between gap-3">
            <span className="truncate font-medium text-ink">
              {device.name === '' ? 'Unnamed device' : device.name}
            </span>
            <DeviceStatusBadge status={deviceStatus[device.id]} />
          </span>
          {selectedId === device.id && (
            <span className="mt-2 block text-xs font-medium text-on">Selected</span>
          )}
          {deviceStatusMessage[device.id] !== undefined && (
            <span className="mt-2 block text-xs text-dim">
              {deviceStatusMessage[device.id]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function RenameDevice({ label, onLabel }: { label: string; onLabel: (label: string) => void }) {
  return (
    <div className="mt-5">
      <label className="mb-1 block text-sm text-dim" htmlFor="device-label">
        Device name (saved when you continue)
      </label>
      <input
        id="device-label"
        className={inputClass}
        value={label}
        onChange={(event) => onLabel(event.target.value)}
      />
    </div>
  );
}

function LiveReading({ kind, sample }: { kind: DeviceKind; sample: DeviceSample | undefined }) {
  if (kind === 'trainer') {
    const cadence = sample?.cadenceRpm ?? null;
    return (
      <div className="mt-5 grid items-center gap-5 rounded-[14px] bg-void/60 p-4 sm:grid-cols-[1fr_180px]">
        <div>
          <p className="text-sm uppercase tracking-[0.06em] text-dim">Live power</p>
          <p className="mt-1 font-display text-5xl font-bold tabular-nums text-ink">
            {sample?.powerW === undefined ? '—' : Math.round(sample.powerW)}
            <span className="ml-1 text-xl text-dim">W</span>
          </p>
          {cadence !== null && cadence > 0 && (
            <p className="mt-3 font-medium text-on">Got it — {Math.round(cadence)} rpm</p>
          )}
        </div>
        <CadenceDial cadenceRpm={cadence} compact />
      </div>
    );
  }

  const heartRate = sample?.hrBpm;
  return (
    <div className="mt-5 rounded-[14px] bg-void/60 p-5">
      <p className="text-sm uppercase tracking-[0.06em] text-dim">Live heart rate</p>
      <p className="mt-1 font-display text-5xl font-bold tabular-nums text-ink">
        {heartRate === undefined ? '—' : Math.round(heartRate)}
        <span className="ml-1 text-xl text-dim">bpm</span>
      </p>
      {heartRate !== undefined && heartRate > 0 && (
        <p className="mt-3 font-medium text-on">Signal received — {Math.round(heartRate)} bpm</p>
      )}
    </div>
  );
}

function DeviceStepActions({
  ready,
  skippable,
  onBack,
  onNext,
  onSkip,
}: {
  ready: boolean;
  skippable: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip?: () => void;
}) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
      <button
        type="button"
        onClick={onBack}
        className="rounded-[8px] border border-line px-4 py-2 text-ink hover:bg-ink/5"
      >
        Back
      </button>
      <div className="flex items-center gap-3">
        {skippable && !ready && (
          <button
            type="button"
            onClick={onSkip}
            className="px-2 py-2 text-sm text-dim underline hover:text-ink"
          >
            Skip for now
          </button>
        )}
        <button
          type="button"
          disabled={!ready}
          onClick={onNext}
          className="rounded-[8px] bg-on px-5 py-2 font-medium text-void hover:bg-on/85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function DeviceSetupStep({
  kind,
  profile,
  devices,
  selectedId,
  discoveryError,
  onSelected,
  onBack,
  onNext,
  onSkip,
}: DeviceStepProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const deviceNoun = kind === 'trainer' ? 'trainer' : 'heart rate strap';
  // Coming Back to a step must keep the name already saved on the device.
  const [label, setLabel] = useState(
    () => devices.find((device) => device.id === selectedId)?.name ?? `${profile.name}'s ${deviceNoun}`,
  );
  const [selectedAt, setSelectedAt] = useState(() => (selectedId === null ? 0 : Date.now()));
  const [error, setError] = useState<string | null>(null);
  const sample = useAppStore((state) =>
    selectedId === null ? undefined : state.deviceSamples[selectedId],
  );
  const liveSample = sample !== undefined && sample.ts >= selectedAt ? sample : undefined;
  const status = useAppStore((state) =>
    selectedId === null ? undefined : state.deviceStatus[selectedId],
  );
  const message = useAppStore((state) =>
    selectedId === null ? undefined : state.deviceStatusMessage[selectedId],
  );
  const ready =
    kind === 'trainer' ? (liveSample?.cadenceRpm ?? 0) > 0 : (liveSample?.hrBpm ?? 0) > 0;
  const pairingHint =
    kind === 'hrm' &&
    (status === 'error' || message?.toLowerCase().includes('pairing') === true);

  async function selectDevice(device: ListedDevice) {
    setBusyId(device.id);
    setError(null);
    try {
      if (selectedId !== null && selectedId !== device.id) {
        await assignDevice(selectedId, null);
      }
      await assignDevice(device.id, profile.id);
      onSelected(device.id);
      setSelectedAt(Date.now());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  }

  // The prefilled name is applied on Next so nobody has to find a separate save button.
  async function saveNameAndContinue() {
    if (selectedId !== null && label.trim() !== '') {
      setBusyId(selectedId);
      setError(null);
      try {
        await labelDevice(selectedId, label.trim());
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setBusyId(null);
        return;
      }
      setBusyId(null);
    }
    onNext();
  }

  const trainer = kind === 'trainer';
  return (
    <section>
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">
        {trainer ? 'Connect your trainer' : 'Connect heart rate'}
      </h1>
      <p className="mb-6 mt-2 text-dim">
        {trainer
          ? 'Pedal a few strokes to wake your trainer.'
          : 'Put on your heart rate strap and wake it.'}
      </p>
      {(error ?? discoveryError) !== null && (
        <p className="mb-4 rounded-[8px] border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {error ?? discoveryError}
        </p>
      )}
      <DeviceChoices
        devices={devices}
        selectedId={selectedId}
        busyId={busyId}
        onSelect={(device) => void selectDevice(device)}
      />
      {selectedId !== null && (
        <>
          <LiveReading kind={kind} sample={liveSample} />
          <RenameDevice label={label} onLabel={setLabel} />
        </>
      )}
      {pairingHint && (
        <p className="mt-4 rounded-[8px] border border-under/40 bg-under/10 px-4 py-3 text-sm text-under">
          Hold the strap button for 4 seconds to pair
        </p>
      )}
      <DeviceStepActions
        ready={ready}
        skippable={!trainer}
        onBack={onBack}
        onNext={() => void saveNameAndContinue()}
        onSkip={onSkip}
      />
    </section>
  );
}

function DoneStep({
  profile,
  trainer,
  hrm,
  onBack,
  onStart,
}: {
  profile: RiderProfile;
  trainer: ListedDevice | undefined;
  hrm: ListedDevice | undefined;
  onBack: () => void;
  onStart: () => void;
}) {
  return (
    <section>
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">
        Ready to ride
      </h1>
      <p className="mt-2 text-dim">Your rider and devices are ready for a first session.</p>
      <dl className="mt-6 divide-y divide-line rounded-[14px] border border-line bg-deep px-5">
        <div className="flex justify-between gap-4 py-4">
          <dt className="text-dim">Rider</dt>
          <dd className="font-medium text-ink">{profile.name}</dd>
        </div>
        <div className="flex justify-between gap-4 py-4">
          <dt className="text-dim">Trainer</dt>
          <dd className="font-medium text-ink">{trainer?.name || 'Connected trainer'}</dd>
        </div>
        <div className="flex justify-between gap-4 py-4">
          <dt className="text-dim">Heart rate</dt>
          <dd className="font-medium text-ink">{hrm?.name || 'Skipped'}</dd>
        </div>
      </dl>
      <div className="mt-6 rounded-[14px] border border-line bg-deep p-5">
        <h2 className="font-display text-lg font-medium uppercase tracking-[0.06em] text-ink">
          Garmin Connect
        </h2>
        <p className="mb-3 mt-1 text-sm text-dim">
          Optional. Sign in now to sync ride history and uploads.
        </p>
        <GarminConnect riderId={profile.id} />
      </div>
      <div className="mt-8 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-[8px] border border-line px-4 py-2 text-ink hover:bg-ink/5"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onStart}
          className="rounded-[8px] bg-on px-5 py-2 font-medium text-void hover:bg-on/85"
        >
          Start your first ride
        </button>
      </div>
    </section>
  );
}

function useDiscoveredDevices(enabled: boolean) {
  const [devices, setDevices] = useState<ListedDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    async function refresh() {
      try {
        const next = await listDevices();
        if (!cancelled) {
          setDevices(next);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return { devices, error };
}

export default function WelcomePage() {
  const navigate = useNavigate();
  const adapterState = useAppStore((state) => state.adapterState);
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<RiderProfile | null>(null);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [hrmId, setHrmId] = useState<string | null>(null);
  const { devices, error } = useDiscoveredDevices(profile !== null);

  useEffect(() => {
    let cancelled = false;
    void getBleState()
      .then(({ state }) => {
        if (!cancelled) {
          useAppStore.getState().applyServer({ type: 'adapterState', state });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const trainers = devices.filter((device) => device.kind === 'trainer');
  const hrms = devices.filter((device) => device.kind === 'hrm');
  const trainer = devices.find((device) => device.id === trainerId);
  const hrm = devices.find((device) => device.id === hrmId);

  function handleRiderSaved(saved: RiderProfile) {
    setProfile(saved);
    setStep(2);
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <WizardProgress step={step} />
      <div className="mt-8 rounded-[14px] border border-line bg-panel p-5 sm:p-8">
        {step === 0 && <BluetoothStep state={adapterState} onNext={() => setStep(1)} />}
        {step === 1 && (
          <RiderStep
            profile={profile}
            onBack={() => setStep(0)}
            onSaved={handleRiderSaved}
          />
        )}
        {step === 2 && profile !== null && (
          <DeviceSetupStep
            key="trainer"
            kind="trainer"
            profile={profile}
            devices={trainers}
            selectedId={trainerId}
            discoveryError={error}
            onSelected={setTrainerId}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && profile !== null && (
          <DeviceSetupStep
            key="hrm"
            kind="hrm"
            profile={profile}
            devices={hrms}
            selectedId={hrmId}
            discoveryError={error}
            onSelected={setHrmId}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
            onSkip={() => setStep(4)}
          />
        )}
        {step === 4 && profile !== null && (
          <DoneStep
            profile={profile}
            trainer={trainer}
            hrm={hrm}
            onBack={() => setStep(3)}
            onStart={() => navigate('/session/new')}
          />
        )}
      </div>
    </div>
  );
}
