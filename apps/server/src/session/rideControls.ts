import type { SessionSnapshot } from '@opencycle/shared';

import type { BleZwiftRideDriver } from '../devices/ble/controller.js';
import type { RideButton } from '../devices/ble/zwiftRide.js';
import type { DeviceHub } from '../devices/hub.js';
import type { SessionEngine } from './engine.js';

type RideAction = { kind: 'bias'; deltaPct: number } | { kind: 'pauseResume' } | { kind: 'skipStep' };
type Rider = SessionSnapshot['riders'][number];

/**
 * The Zwift Ride button map. Shifters step the ERG bias like the UI's ±1 %
 * buttons, the way Zwift shifts: either right button harder, either left
 * button easier. A pauses or resumes, Y skips the step on a second press
 * within SKIP_CONFIRM_MS. No button ends a ride.
 */
export const RIDE_BUTTON_ACTIONS: Readonly<Partial<Record<RideButton, RideAction>>> = {
  shiftUpRight: { kind: 'bias', deltaPct: 1 },
  shiftDownRight: { kind: 'bias', deltaPct: 1 },
  shiftUpLeft: { kind: 'bias', deltaPct: -1 },
  shiftDownLeft: { kind: 'bias', deltaPct: -1 },
  a: { kind: 'pauseResume' },
  y: { kind: 'skipStep' },
};

export const SKIP_CONFIRM_MS = 1500;

/**
 * Links the Zwift Ride controllers only while a session runs: a controller
 * takes one central, and outside a session its presses have no rider, so
 * Zwift may have it then. Presses go to the session's only active rider; with
 * several, to the rider on `frameTrainer` (the trainer the frame sits on, by
 * device id or advertised name). Otherwise a press is dropped and the reason
 * logged once.
 */
export function attachRideControls(
  hub: DeviceHub,
  engine: SessionEngine,
  opts: { frameTrainer: string | undefined; log: (message: string) => void },
): void {
  const controllers = new Set<BleZwiftRideDriver>();
  let skipArmed: { riderId: string; at: number } | null = null;
  let lastDropReason: string | null = null;

  const press = (button: RideButton): void => {
    const action = RIDE_BUTTON_ACTIONS[button];
    if (action === undefined) return;
    const rider = targetRider(engine.session?.riders ?? [], opts.frameTrainer, (id) => hub.find(id)?.name);
    if (typeof rider === 'string') {
      if (rider !== lastDropReason) opts.log(`Zwift Ride ${button} ignored: ${rider}`);
      lastDropReason = rider;
      return;
    }
    lastDropReason = null;
    const { riderId } = rider;
    if (action.kind === 'bias') {
      engine.setBias(riderId, action.deltaPct);
    } else if (action.kind === 'pauseResume') {
      if (rider.state === 'paused') engine.resume(riderId);
      else engine.pause(riderId);
    } else {
      const now = Date.now();
      if (skipArmed?.riderId === riderId && now - skipArmed.at <= SKIP_CONFIRM_MS) {
        skipArmed = null;
        engine.skipStep(riderId);
      } else {
        skipArmed = { riderId, at: now };
      }
    }
  };

  // Link failures surface as the drivers' status events.
  hub.on('controller', (controller) => {
    controllers.add(controller);
    controller.on('press', press);
    if (engine.session) void controller.connect().catch(() => undefined);
  });
  engine.on('event', (event) => {
    if (event.kind !== 'riderJoined') return;
    for (const controller of controllers) void controller.connect().catch(() => undefined);
  });
  engine.on('ended', () => {
    for (const controller of controllers) void controller.disconnect();
  });
}

/** The only active rider, else the one on the frame's trainer; a string says why there is none. */
function targetRider(
  riders: Rider[],
  frameTrainer: string | undefined,
  trainerName: (trainerId: string) => string | undefined,
): Rider | string {
  const active = riders.filter((rider) => rider.state !== 'stopped');
  if (active.length === 1) return active[0]!;
  if (active.length === 0) return 'no rider is riding';
  const onFrame = active.filter(
    (rider) =>
      frameTrainer !== undefined && (rider.trainerId === frameTrainer || trainerName(rider.trainerId) === frameTrainer),
  );
  if (onFrame.length === 1) return onFrame[0]!;
  return `${active.length} riders and none on the frame's trainer (set OPENCYCLE_ZWIFT_RIDE_TRAINER)`;
}
