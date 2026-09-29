import { create } from 'zustand';
import type {
  SessionEvent,
  SessionSnapshot,
  TelemetrySample,
  WsServerMessage,
} from '@opencycle/shared';

const TELEMETRY_CAP = 900;
const EVENTS_CAP = 200;
const SPACE_GAME_KEY = 'opencycle.spaceGame';
/** Pre-revamp key; migrated once, then removed. */
const LEGACY_GAME_MODE_KEY = 'opencycle.gameMode';

/**
 * Space game on/off; on by default. Migrates the old tri-state gameMode key
 * ('off' meant off) the first time the app loads after the revamp.
 */
function loadSpaceGame(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const legacy = localStorage.getItem(LEGACY_GAME_MODE_KEY);
    if (legacy !== null) {
      localStorage.removeItem(LEGACY_GAME_MODE_KEY);
      return legacy !== 'off';
    }
    const raw = localStorage.getItem(SPACE_GAME_KEY);
    return raw === null ? true : raw === 'on';
  } catch {
    return true;
  }
}

export interface AppState {
  wsStatus: 'connecting' | 'open' | 'closed';
  session: SessionSnapshot | null;
  /** Per riderId, newest last, capped at 900 samples. */
  telemetry: Record<string, TelemetrySample[]>;
  latest: Record<string, TelemetrySample | undefined>;
  /** Newest last, capped at 200. */
  events: SessionEvent[];
  /** deviceId -> last status kind. */
  deviceStatus: Record<string, string>;
  /** Last server `error` frame message, additive to the frozen contract. */
  lastError: string | null;
  /**
   * True once a sessionState frame (session or null) has arrived on the
   * current connection: the server always sends one on connect, so routing
   * decisions (e.g. redirecting away from the dashboard) must wait for it.
   */
  hydrated: boolean;
  /** Space game on/off; when off the ride page shows the plain dashboard. */
  spaceGame: boolean;
  setSpaceGame(on: boolean): void;
  applyServer(msg: WsServerMessage): void;
  setWsStatus(s: AppState['wsStatus']): void;
  /**
   * Terminal teardown of session-scoped state. Fires ONLY on the server's
   * explicit `sessionState: null` frame — never on socket close (a reconnect
   * must keep the last-known session on screen).
   */
  clearSession(): void;
}

export const useAppStore = create<AppState>()((set) => ({
  wsStatus: 'connecting',
  session: null,
  telemetry: {},
  latest: {},
  events: [],
  deviceStatus: {},
  lastError: null,
  hydrated: false,
  spaceGame: loadSpaceGame(),

  setSpaceGame: (on) => {
    try {
      localStorage.setItem(SPACE_GAME_KEY, on ? 'on' : 'off');
    } catch {
      // Storage unavailable (private mode/quota): the setting still applies
      // for this page session.
    }
    set({ spaceGame: on });
  },

  applyServer: (msg) => {
    switch (msg.type) {
      case 'telemetry': {
        set((state) => {
          const telemetry = { ...state.telemetry };
          const latest = { ...state.latest };
          for (const sample of msg.samples) {
            const prev = telemetry[sample.riderId];
            telemetry[sample.riderId] =
              prev === undefined
                ? [sample]
                : prev.length >= TELEMETRY_CAP
                  ? [...prev.slice(prev.length - TELEMETRY_CAP + 1), sample]
                  : [...prev, sample];
            latest[sample.riderId] = sample;
          }
          return { telemetry, latest };
        });
        break;
      }
      case 'sessionEvent': {
        set((state) => {
          const events =
            state.events.length >= EVENTS_CAP
              ? [...state.events.slice(state.events.length - EVENTS_CAP + 1), msg.event]
              : [...state.events, msg.event];
          return { events };
        });
        break;
      }
      case 'sessionState': {
        // session: null is the explicit terminal frame — the server sends it
        // after stopSession completes and after startSession rollback. It is
        // the ONLY ws-side trigger for clearing session state; a dropped
        // socket must NOT clear it (the last-known session stays on screen).
        if (msg.session === null) {
          useAppStore.getState().clearSession();
          set({ hydrated: true });
          break;
        }
        const snapshot = msg.session;
        set((state) => {
          const telemetry = { ...state.telemetry };
          for (const rider of snapshot.riders) {
            if (telemetry[rider.riderId] === undefined) telemetry[rider.riderId] = [];
          }
          return { session: snapshot, telemetry, hydrated: true };
        });
        break;
      }
      case 'deviceStatus': {
        set((state) => ({ deviceStatus: { ...state.deviceStatus, [msg.deviceId]: msg.status } }));
        break;
      }
      case 'error': {
        set({ lastError: msg.message });
        break;
      }
    }
  },

  setWsStatus: (status) => set({ wsStatus: status }),

  clearSession: () => set({ session: null, telemetry: {}, latest: {}, events: [], lastError: null }),
}));
