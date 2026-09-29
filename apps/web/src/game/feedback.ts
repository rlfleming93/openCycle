import type { SessionSnapshot } from '@opencycle/shared';

type RiderSnapshot = SessionSnapshot['riders'][number];

export type EffortCueState =
  | 'unavailable'
  | 'stopped'
  | 'paused'
  | 'guard'
  | 'under'
  | 'locked'
  | 'over'
  | 'free';

export interface EffortCueInput {
  rider: RiderSnapshot;
  trainerStatus?: string;
  avgPowerW: number | null;
  cadenceRpm: number | null;
}

export interface EffortCue {
  state: EffortCueState;
  instruction: string;
  deltaW: number | null;
  tone: 'neutral' | 'cool' | 'emerald' | 'amber';
}

export interface WorkoutCommand {
  primary: string;
  secondary: string | null;
  remainingS: number | null;
}

const unavailableStatuses = new Set(['disconnected', 'error', 'controlLost']);

export function getEffortCue(input: EffortCueInput): EffortCue {
  const { rider, trainerStatus, avgPowerW, cadenceRpm } = input;
  if (trainerStatus !== undefined && unavailableStatuses.has(trainerStatus)) {
    return { state: 'unavailable', instruction: 'WAITING FOR TRAINER', deltaW: null, tone: 'neutral' };
  }
  if (rider.state === 'stopped') return { state: 'stopped', instruction: 'PEDAL TO RESTART', deltaW: null, tone: 'neutral' };
  if (rider.state === 'paused') return { state: 'paused', instruction: 'PAUSED', deltaW: null, tone: 'neutral' };
  if (rider.ergGuardActive) return { state: 'guard', instruction: 'RECOVERY MODE', deltaW: null, tone: 'amber' };
  if (avgPowerW === null || cadenceRpm === null) return { state: 'unavailable', instruction: 'WAITING FOR TRAINER', deltaW: null, tone: 'neutral' };
  if (cadenceRpm <= 5) return { state: 'stopped', instruction: 'PEDAL TO RESTART', deltaW: null, tone: 'neutral' };
  if (rider.targetW === null || rider.targetW <= 0) return { state: 'free', instruction: 'RIDE FREE', deltaW: null, tone: 'cool' };

  const deltaW = Math.round(rider.targetW - avgPowerW);
  const ratio = avgPowerW / rider.targetW;
  if (ratio < 0.9) return { state: 'under', instruction: `ADD ${deltaW} W`, deltaW, tone: 'cool' };
  if (ratio <= 1.1) return { state: 'locked', instruction: 'ON TARGET', deltaW, tone: 'emerald' };
  return { state: 'over', instruction: `EASE ${Math.abs(deltaW)} W`, deltaW, tone: 'amber' };
}

export function getWorkoutCommand(rider: RiderSnapshot): WorkoutCommand {
  const remainingS = rider.stepCueRemainingS;
  if (rider.state === 'paused') {
    return { primary: 'PAUSED', secondary: null, remainingS: null };
  }
  if (rider.state === 'stopped') {
    return { primary: 'STOPPED', secondary: null, remainingS: null };
  }
  if (rider.stepKind === 'ramp') {
    return {
      primary: rider.nextTargetW === null ? 'RAMP' : `RAMP TO ${Math.round(rider.nextTargetW)} W`,
      secondary: null,
      remainingS,
    };
  }
  if (rider.stepKind === 'steady' || rider.stepKind === 'interval') {
    return {
      primary: rider.targetW === null ? 'RIDE FREE' : `HOLD ${Math.round(rider.targetW)} W`,
      secondary: rider.nextTargetW === null ? null : `NEXT ${Math.round(rider.nextTargetW)} W`,
      remainingS,
    };
  }
  if (rider.stepKind === 'free') {
    return {
      primary: 'RIDE FREE',
      secondary: rider.nextTargetW === null ? null : `NEXT ${Math.round(rider.nextTargetW)} W`,
      remainingS,
    };
  }
  return {
    primary: rider.workoutId === undefined ? 'RIDE FREE' : 'MISSION COMPLETE',
    secondary: null,
    remainingS: null,
  };
}
