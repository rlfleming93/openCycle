import type {
  DeviceInfo,
  RiderProfile,
  RiderStart,
  SessionSnapshot,
} from '@opencycle/shared';

import { useAppStore } from '../store.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** POST /api/profiles body: a profile without its server-assigned id. */
export type ProfileInput = Omit<RiderProfile, 'id'>;

/** Device row as served by GET /api/devices; `riderId` present when assigned. */
export interface ListedDevice extends DeviceInfo {
  riderId?: string;
}

export type WorkoutSource = 'library' | 'import';

export interface WorkoutListItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: WorkoutSource;
}

/** Garmin upload lifecycle as served on rides rows and /upload-status. */
export type RideUploadStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

export interface RideListItem {
  id: string;
  riderId: string;
  startedAt: number;
  endedAt: number | null;
  workoutName: string | null;
  summary: unknown;
  /** Garmin upload state; null when an upload was never attempted. */
  uploadStatus: RideUploadStatus | null;
  uploadError: string | null;
}

/** fetch helper: throws Error(body.error) on !ok, parses JSON otherwise. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // non-JSON error body; keep the status text
    }
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function listProfiles(): Promise<RiderProfile[]> {
  return request('/api/profiles');
}

export function createProfile(input: ProfileInput): Promise<RiderProfile> {
  return request('/api/profiles', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) });
}

export function updateProfile(id: string, input: ProfileInput): Promise<RiderProfile> {
  return request(`/api/profiles/${id}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(input) });
}

export function deleteProfile(id: string): Promise<void> {
  return request(`/api/profiles/${id}`, { method: 'DELETE' });
}

export function listDevices(): Promise<ListedDevice[]> {
  return request('/api/devices');
}

export function assignDevice(deviceId: string, riderId: string | null): Promise<ListedDevice> {
  return request(`/api/devices/${deviceId}/assign`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ riderId }),
  });
}

export function forgetDevice(deviceId: string): Promise<void> {
  return request(`/api/devices/${deviceId}`, { method: 'DELETE' });
}

export function listWorkouts(): Promise<WorkoutListItem[]> {
  return request('/api/workouts');
}

export function importZwo(xml: string): Promise<WorkoutListItem> {
  return request('/api/workouts/import', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ xml }),
  });
}

export function listRides(riderId?: string): Promise<RideListItem[]> {
  const query = riderId === undefined ? '' : `?riderId=${encodeURIComponent(riderId)}`;
  return request(`/api/rides${query}`);
}

/** One stored 1 Hz sample row as served by GET /api/rides/:id/samples (raw ride_samples columns, nulls passed through). */
export interface RideSample {
  ts: number;
  powerW: number;
  cadenceRpm: number;
  hrBpm: number | null;
  speedKmh: number;
  distanceM: number;
  targetW: number | null;
}

/** Per-second samples for a ride, oldest first. 404 for unknown ride ids. */
export function listRideSamples(rideId: string): Promise<RideSample[]> {
  return request(`/api/rides/${encodeURIComponent(rideId)}/samples`);
}

/** Download URL for a ride's FIT file. */
export function fitUrl(rideId: string): string {
  return `/api/rides/${encodeURIComponent(rideId)}/fit`;
}

export async function startSession(riders: RiderStart[]): Promise<SessionSnapshot> {
  const snapshot = await request<SessionSnapshot>('/api/sessions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ riders }),
  });
  // Mirror the server's sessionState broadcast so the dashboard renders
  // immediately instead of waiting for the WS frame.
  useAppStore.getState().applyServer({ type: 'sessionState', session: snapshot });
  return snapshot;
}

/** One imported activity row as served by GET /api/activities (no streams). */
export interface ActivityListItem {
  id: string;
  source: string;
  riderId: string | null;
  startedAt: number;
  durationS: number;
  sport: string | null;
  name: string | null;
  summary: unknown;
}

export function listActivities(riderId?: string): Promise<ActivityListItem[]> {
  const query = riderId === undefined ? '' : `?riderId=${encodeURIComponent(riderId)}`;
  return request(`/api/activities${query}`);
}

/** Result of a Garmin ZIP/FIT import as served by POST /api/garmin/import-zip. */
export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * Upload a Garmin account-export ZIP (or a loose FIT) as multipart; a non-null
 * riderId attributes every imported activity to that rider at import time.
 * 409 (session active) surfaces as an error with `status` 409.
 */
export function importGarminZip(riderId: string | null, file: File): Promise<ImportResult> {
  const query = riderId === null ? '' : `?riderId=${encodeURIComponent(riderId)}`;
  const body = new FormData();
  body.append('file', file);
  return request(`/api/garmin/import-zip${query}`, { method: 'POST', body });
}

/** Bulk-assign imported activities to a rider (null = unassigned). */
export function assignActivities(riderId: string | null, ids: string[]): Promise<{ updated: number }> {
  return request('/api/activities/assign', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ riderId, ids }),
  });
}

/** Start an async Garmin Connect history pull for a rider (202 { status: 'started' }). */
export function pullGarmin(riderId: string): Promise<{ status: 'started' }> {
  return request(`/api/garmin/pull/${encodeURIComponent(riderId)}`, { method: 'POST' });
}

/** Daily load plus the Banister curves as served by GET /api/training/load. */
export interface TrainingLoadResponse {
  days: { date: string; load: number }[];
  fitness: number[];
  fatigue: number[];
  form: number[];
}

export function getTrainingLoad(riderId?: string): Promise<TrainingLoadResponse> {
  const query = riderId === undefined ? '' : `?riderId=${encodeURIComponent(riderId)}`;
  return request(`/api/training/load${query}`);
}

/** FTP estimate from a rider's last 6 months of power data; null when none qualifies. */
export function ftpFromHistory(profileId: string): Promise<{ ftpW: number | null }> {
  return request(`/api/profiles/${encodeURIComponent(profileId)}/ftp-from-history`, { method: 'POST' });
}

/**
 * FTP estimates from one ride's power stream; null = not applicable for this
 * ride (twentyMin when fewer than 1200 samples, ramp unless the ride's
 * workout was the FTP ramp test).
 */
export interface FtpEstimates {
  ramp: number | null;
  twentyMin: number | null;
}

export function ftpEstimates(rideId: string): Promise<FtpEstimates> {
  return request(`/api/rides/${encodeURIComponent(rideId)}/ftp-estimates`);
}

/** Queue a ride's FIT for upload to Garmin Connect (202 { status: 'queued' }). */
export function uploadRide(rideId: string): Promise<{ status: 'queued' }> {
  return request(`/api/rides/${encodeURIComponent(rideId)}/upload`, { method: 'POST' });
}

/** Current Garmin upload state for a ride; poll until uploaded/failed. */
export function rideUploadStatus(rideId: string): Promise<{
  uploadStatus: RideUploadStatus | null;
  uploadError: string | null;
}> {
  return request(`/api/rides/${encodeURIComponent(rideId)}/upload-status`);
}

/** A curated plan template (data/plans/templates/*.json); every listed day has a workout (rest days are simply absent). */
export interface PlanTemplate {
  id: string;
  name: string;
  description: string;
  weeks: { days: { dow: number; workoutId: string }[] }[];
}

export function listPlans(): Promise<PlanTemplate[]> {
  return request('/api/plans');
}

/** One day of a rendered plan assignment calendar. */
export interface PlanCalendarEntry {
  date: string;
  workoutId: string;
  workoutName: string;
}

export interface PlanAssignment {
  id: string;
  riderId: string;
  templateId: string;
  startDate: string;
  calendar: PlanCalendarEntry[];
}

export interface AssignPlanInput {
  riderId: string;
  templateId: string;
  startDate: string;
}

export function assignPlan(input: AssignPlanInput): Promise<PlanAssignment> {
  return request('/api/plans/assign', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

export function listPlanAssignments(riderId?: string): Promise<PlanAssignment[]> {
  const query = riderId === undefined ? '' : `?riderId=${encodeURIComponent(riderId)}`;
  return request(`/api/plans/assignments${query}`);
}

export function deleteAssignment(assignmentId: string): Promise<void> {
  return request(`/api/plans/assignments/${encodeURIComponent(assignmentId)}`, { method: 'DELETE' });
}

/** A co-op discovery as served by GET /api/discoveries (newest first). */
export interface Discovery {
  id: string;
  kind: 'beacon' | 'rescue';
  seed: string;
  name: string;
  sessionId: string;
  /** Cumulative both-in-zone seconds; set for beacons, null for rescues. */
  streakS: number | null;
  riderIds: string[];
  createdAt: number;
}

/** Co-op discoveries (survey beacons + answered rescues), newest first. */
export function listDiscoveries(limit?: number): Promise<Discovery[]> {
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`;
  return request(`/api/discoveries${query}`);
}

/** One arrived system in a rider's voyage, oldest first. */
export interface VoyageSystem {
  id: string;
  sessionId: string;
  voyageIndex: number;
  seed: string;
  name: string;
  workoutId: string | null;
  workoutName: string | null;
  /** Objective legs of that workout; null for rows migrated before surveys existed. */
  surveysTotal: number | null;
  surveysClean: number | null;
  arrivedAt: number;
}

/** GET /api/voyage: the rider's arrived systems plus the next destination. */
export interface Voyage {
  riderId: string;
  systems: VoyageSystem[];
  next: { voyageIndex: number; seed: string; name: string };
}

export function getVoyage(riderId: string): Promise<Voyage> {
  return request(`/api/voyage?riderId=${encodeURIComponent(riderId)}`);
}

