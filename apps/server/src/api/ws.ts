import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import {
  WsClientMessageSchema,
  type SessionEvent,
  type SessionSnapshot,
  type TelemetrySample,
  type WsClientMessage,
  type WsServerMessage,
} from '@opencycle/shared';

import { HrmDriver, TrainerDriver, type TrainerStatus } from '../devices/driver.js';
import { sessionDestination } from '../game/voyage.js';
import type { ApiContext } from './routes.js';
import { resolveRiderConfigs } from './routes.js';

function send(socket: WebSocket, message: WsServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function parseClientMessage(raw: unknown, app: FastifyInstance): WsClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    app.log.warn('Ignoring non-JSON ws message');
    return null;
  }
  const result = WsClientMessageSchema.safeParse(parsed);
  if (!result.success) {
    app.log.warn('Ignoring invalid ws message');
    return null;
  }
  return result.data;
}

/** Dispatches a validated client message to the session engine. */
async function dispatch(ctx: ApiContext, message: WsClientMessage): Promise<void> {
  switch (message.type) {
    case 'startSession': {
      const configs = await resolveRiderConfigs(ctx, message.riders);
      await ctx.engine.startSession(configs, { destination: sessionDestination(ctx.db, configs) });
      break;
    }
    case 'setBias':
      ctx.engine.setBias(message.riderId, message.deltaPct);
      break;
    case 'pause':
      ctx.engine.pause(message.riderId);
      break;
    case 'resume':
      ctx.engine.resume(message.riderId);
      break;
    case 'skipStep':
      ctx.engine.skipStep(message.riderId);
      break;
    case 'stopRider':
      await ctx.engine.stopRider(message.riderId);
      break;
    case 'stopSession':
      await ctx.engine.stopSession();
      break;
  }
}

/**
 * Registers the /ws endpoint: pushes engine telemetry/events/state and driver
 * status changes to every socket and dispatches zod-validated client messages.
 * Invalid messages are logged and ignored; dispatch failures send an `error`
 * frame to the offending socket. Every connect receives an initial
 * sessionState frame (session or null) as the client hydration signal.
 */
export function registerWs(app: FastifyInstance, ctx: ApiContext): void {
  const sockets = new Set<WebSocket>();
  const broadcast = (message: WsServerMessage): void => {
    for (const socket of sockets) send(socket, message);
  };

  // deviceStatus: mirror every driver's status event to all sockets, for
  // already-known drivers and for devices discovered later.
  const statusSubs: Array<{ driver: TrainerDriver | HrmDriver; handler: (status: TrainerStatus) => void }> = [];
  const subscribeStatus = (driver: TrainerDriver | HrmDriver): void => {
    const handler = (status: TrainerStatus): void => {
      broadcast({
        type: 'deviceStatus',
        deviceId: driver.id,
        kind: driver instanceof TrainerDriver ? 'trainer' : 'hrm',
        status: status.kind,
      });
    };
    driver.on('status', handler);
    statusSubs.push({ driver, handler });
  };
  const onTrainerDiscovered = (trainer: TrainerDriver): void => subscribeStatus(trainer);
  const onHrmDiscovered = (hrm: HrmDriver): void => subscribeStatus(hrm);
  for (const trainer of ctx.hub.drivers().trainers) subscribeStatus(trainer);
  for (const hrm of ctx.hub.drivers().hrms) subscribeStatus(hrm);
  ctx.hub.on('trainer', onTrainerDiscovered);
  ctx.hub.on('hrm', onHrmDiscovered);

  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    // Always send an initial sessionState (null included): clients use this
    // frame as the hydration signal before making routing decisions.
    send(socket, { type: 'sessionState', session: ctx.engine.session });

    const onTelemetry = (samples: TelemetrySample[]): void => {
      send(socket, { type: 'telemetry', samples });
    };
    const onEvent = (event: SessionEvent): void => {
      send(socket, { type: 'sessionEvent', event });
    };
    const onState = (state: SessionSnapshot): void => {
      send(socket, { type: 'sessionState', session: state });
    };
    // Terminal frame: session: null tells clients the session is over (stop
    // completed or a start rolled back); the engine emits 'ended' once the
    // session is fully cleared. Per-socket send — broadcast here would fan
    // out N duplicate frames per client (one per registered socket).
    const onEnded = (): void => {
      send(socket, { type: 'sessionState', session: null });
    };

    ctx.engine.on('telemetry', onTelemetry);
    ctx.engine.on('event', onEvent);
    ctx.engine.on('state', onState);
    ctx.engine.on('ended', onEnded);

    socket.on('message', (raw: unknown) => {
      const message = parseClientMessage(raw, app);
      if (message === null) return;
      void dispatch(ctx, message).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        app.log.warn({ err }, 'ws message dispatch failed');
        send(socket, { type: 'error', message: detail });
      });
    });

    socket.on('close', () => {
      sockets.delete(socket);
      ctx.engine.off('telemetry', onTelemetry);
      ctx.engine.off('event', onEvent);
      ctx.engine.off('state', onState);
      ctx.engine.off('ended', onEnded);
    });
  });

  app.addHook('onClose', () => {
    ctx.hub.off('trainer', onTrainerDiscovered);
    ctx.hub.off('hrm', onHrmDiscovered);
    for (const { driver, handler } of statusSubs) driver.off('status', handler);
  });
}
