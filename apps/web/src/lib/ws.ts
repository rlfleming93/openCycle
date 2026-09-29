import { TelemetrySampleSchema, WsServerMessageSchema, type TelemetrySample, type WsClientMessage } from '@opencycle/shared';

import { useAppStore } from '../store.js';

const MAX_RETRY_MS = 10000;
const INITIAL_RETRY_MS = 1000;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelayMs = INITIAL_RETRY_MS;

/** Connects to the server WS endpoint; auto-reconnects with 1s→10s backoff. Idempotent singleton. */
export function connectWs(): void {
  if (socket !== null && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }
  const store = useAppStore.getState();
  store.setWsStatus('connecting');

  const url = `${location.origin.replace(/^http/, 'ws')}/ws`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    retryDelayMs = INITIAL_RETRY_MS;
    useAppStore.getState().setWsStatus('open');
  };

  socket.onmessage = (event) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(event.data));
    } catch {
      return; // invalid frames are dropped silently
    }
    // Telemetry is salvaged per sample: one malformed sample must not drop
    // a whole 1 Hz batch (the batch itself still applies when it carries
    // valid samples). All other frame types stay strictly validated.
    if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'telemetry') {
      const unknownSamples = Array.isArray((raw as { samples?: unknown }).samples)
        ? ((raw as { samples: unknown[] }).samples)
        : [];
      const samples = unknownSamples.filter((s): s is TelemetrySample => TelemetrySampleSchema.safeParse(s).success);
      if (samples.length > 0) {
        useAppStore.getState().applyServer({ type: 'telemetry', samples });
      }
      return;
    }
    const result = WsServerMessageSchema.safeParse(raw);
    if (!result.success) return;
    useAppStore.getState().applyServer(result.data);
  };

  socket.onerror = () => {
    // Dev-only transport log; recovery happens in onclose.
    console.error('[ws] connection error');
  };

  socket.onclose = () => {
    socket = null;
    // hydrated is per-connection: the next connection's initial sessionState
    // frame re-hydrates before any routing decision.
    useAppStore.setState({ wsStatus: 'closed', hydrated: false });
    // Keep the last-known session on screen while the socket is down: the
    // server re-sends a fresh sessionState on reconnect, and only the
    // terminal sessionState(null) frame clears it.
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectWs();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
}

/** Sends a validated client message; silently drops when the socket is closed. */
export function sendWs(message: WsClientMessage): void {
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
