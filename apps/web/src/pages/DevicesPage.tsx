import { useEffect, useState } from 'react';

import type { DeviceInfo, RiderProfile } from '@opencycle/shared';

import { assignDevice, forgetDevice, listDevices, listProfiles } from '../lib/api.js';
import { useAppStore } from '../store.js';

type ListedDevice = DeviceInfo & { riderId?: string };

const STATUS_STYLES: Record<string, string> = {
  connecting: 'border-under/40 bg-under/10 text-under',
  connected: 'border-under/40 bg-under/10 text-under',
  controlAcquired: 'border-on/40 bg-on/10 text-on',
  controlLost: 'border-danger/40 bg-danger/10 text-danger',
  disconnected: 'border-danger/40 bg-danger/10 text-danger',
  error: 'border-danger/40 bg-danger/10 text-danger',
};

const UNKNOWN_STATUS = 'border-line bg-panel/60 text-dim';

const selectClass =
  'rounded-[8px] border border-line bg-deep px-2 py-1.5 text-ink focus:border-on focus:outline-none disabled:opacity-50';

function relativeTime(lastSeen: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - lastSeen) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 10)}…`;
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<ListedDevice[] | null>(null);
  const [profiles, setProfiles] = useState<RiderProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const deviceStatus = useAppStore((s) => s.deviceStatus);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const devices = await listDevices();
        if (!cancelled) {
          setDevices(devices);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void poll();
    const pollId = setInterval(() => void poll(), 3000);
    const tickId = setInterval(() => setNow(Date.now()), 1000);
    void listProfiles()
      .then((ps) => {
        if (!cancelled) setProfiles(ps);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  async function handleAssign(device: ListedDevice, riderId: string | null) {
    setBusyId(device.id);
    setError(null);
    try {
      const updated = await assignDevice(device.id, riderId);
      setDevices((ds) => (ds === null ? ds : ds.map((d) => (d.id === device.id ? updated : d))));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleForget(device: ListedDevice) {
    if (!window.confirm(`Forget device "${device.name}"? It will reappear when it advertises again.`)) return;
    setBusyId(device.id);
    setError(null);
    try {
      await forgetDevice(device.id);
      setDevices((ds) => (ds === null ? ds : ds.filter((d) => d.id !== device.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function deviceCard(device: ListedDevice) {
    const status = deviceStatus[device.id];
    const fresh = now - device.lastSeen < 5000;
    return (
      <div
        key={device.id}
        className={`rounded-[14px] border p-5 ${
          fresh
            ? 'border-on/50 bg-on/5 ring-1 ring-on/40'
            : 'border-line bg-panel'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-semibold text-ink">
                {device.name === '' ? 'Unnamed device' : device.name}
              </h3>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                  status === undefined ? UNKNOWN_STATUS : (STATUS_STYLES[status] ?? UNKNOWN_STATUS)
                }`}
              >
                {status ?? 'unknown'}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-dim">{shortId(device.id)}</p>
          </div>
          <div className="shrink-0 text-right text-xs text-dim">
            <p>{fresh ? 'Advertising' : 'Seen'}</p>
            <p className="text-dim">{relativeTime(device.lastSeen, now)}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-dim">
            Assign to
            <select
              className={selectClass}
              value={device.riderId ?? ''}
              disabled={busyId === device.id}
              onChange={(e) => void handleAssign(device, e.target.value === '' ? null : e.target.value)}
            >
              <option value="">Unassigned</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => void handleForget(device)}
            disabled={busyId === device.id}
            className="ml-auto rounded-[8px] border border-line px-2 py-1 text-xs text-ink/90 hover:bg-ink/10 disabled:opacity-50"
          >
            Forget
          </button>
        </div>
      </div>
    );
  }

  const trainers = (devices ?? []).filter((d) => d.kind === 'trainer');
  const hrms = (devices ?? []).filter((d) => d.kind === 'hrm');

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">Devices</h1>
      <p className="mt-1 text-sm text-dim">
        Pair trainers and heart rate straps. Cards highlighted green are advertising right now.
      </p>

      {error !== null && (
        <p className="mt-4 rounded-[8px] border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">{error}</p>
      )}

      {devices === null && <p className="mt-6 text-dim">Scanning for devices…</p>}

      {devices !== null && (
        <div className="mt-6 space-y-8">
          {[
            { title: 'Trainers', list: trainers },
            { title: 'Heart rate straps', list: hrms },
          ].map((section) => (
            <section key={section.title}>
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-dim">{section.title}</h2>
              {section.list.length === 0 ? (
                <p className="text-sm text-dim/70">None paired yet. Power on a device and it appears here.</p>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{section.list.map(deviceCard)}</div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
