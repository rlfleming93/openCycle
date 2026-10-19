import { useEffect, useState } from 'react';

import type { GarminLoginStatus } from '@opencycle/shared';

import { getGarminLogin, startGarminLogin } from '../lib/api.js';

interface GarminConnectProps {
  riderId: string;
}

export default function GarminConnect({ riderId }: GarminConnectProps) {
  const [status, setStatus] = useState<GarminLoginStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [starting, setStarting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const polling = status?.state === 'installing' || status?.state === 'running';

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const next = await getGarminLogin(riderId);
        if (!cancelled) {
          setStatus(next);
          setRequestError(null);
        }
      } catch (error) {
        if (!cancelled) setRequestError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    void refresh();
    if (!polling) {
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [polling, riderId]);

  async function beginLogin() {
    setStarting(true);
    setRequestError(null);
    try {
      const result = await startGarminLogin(riderId);
      setStatus({ hasLogin: false, state: result.state });
    } catch (error) {
      const conflict =
        typeof error === 'object' && error !== null && 'status' in error && error.status === 409;
      if (conflict) {
        try {
          setStatus(await getGarminLogin(riderId));
        } catch (refreshError) {
          setRequestError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
      } else {
        setRequestError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setStarting(false);
      setChecking(false);
    }
  }

  if (polling) {
    return (
      <p aria-live="polite" className="flex items-start gap-2 text-sm text-under">
        <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-under" />
        {status?.state === 'installing'
          ? 'Installing browser…'
          : 'Finish signing in in the browser window that opened…'}
      </p>
    );
  }

  // Failure wins over a saved login: a failed re-login must stay visible.
  const error = status?.state === 'failed' ? (status.error ?? 'Garmin login failed.') : requestError;
  if (error !== null) {
    return (
      <div className="space-y-2">
        <p aria-live="polite" className="text-sm text-danger">
          {error}
        </p>
        <button
          type="button"
          disabled={starting}
          onClick={() => void beginLogin()}
          className="rounded-[8px] border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-danger/10 disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Retry'}
        </button>
      </div>
    );
  }

  if (status?.hasLogin === true) {
    // Garmin sessions expire; Reconnect replaces the saved login.
    return (
      <p className="flex items-center gap-2 text-sm font-medium text-on">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-on" />
        Garmin connected
        <button
          type="button"
          disabled={starting}
          onClick={() => void beginLogin()}
          className="ml-2 text-xs font-normal text-dim underline hover:text-ink disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Reconnect'}
        </button>
      </p>
    );
  }

  if (checking) return <p className="text-sm text-dim">Checking Garmin…</p>;

  return (
    <button
      type="button"
      disabled={starting}
      onClick={() => void beginLogin()}
      className="rounded-[8px] border border-on/40 px-3 py-1.5 text-sm font-medium text-on hover:bg-on/10 disabled:opacity-50"
    >
      {starting ? 'Starting…' : 'Connect Garmin'}
    </button>
  );
}
