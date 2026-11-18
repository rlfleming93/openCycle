import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

const SSO_EMBED = 'https://sso.garmin.com/sso/embed';
const CONNECTAPI = 'https://connectapi.garmin.com';

/**
 * Garmin churn point — update here.
 *
 * Garmin has no personal API, and Cloudflare answers a scripted or headless sign-in with HTTP 427. This is
 * the Connect Android app's DI OAuth2 flow, as python-garminconnect 0.3.20 drives it and Saga runs in
 * production: the rider signs in once in a real Chrome (login.ts), the SSO service ticket buys an access +
 * refresh token from diauth, and each refresh rotates the pair. Every Garmin string lives here.
 *
 * Upload, from python-garminconnect 0.3.20: `api/activities.py` `upload_activity()` posts multipart field
 * `file` (filename = the file's base name) to `self.garmin_connect_upload`, which `api/base.py` sets to
 * `/upload-service/upload` on connectapi; `client/transport.py` `get_api_headers()` adds the Bearer token,
 * `Accept: application/json` and the native app headers below. Garmin answers 409 for a file it already has.
 */
export const GARMIN = {
  signInUrl: `${SSO_EMBED}?${new URLSearchParams({
    id: 'gauth-widget',
    embedWidget: 'true',
    gauthHost: 'https://sso.garmin.com/sso',
    clientId: 'GarminConnect',
    locale: 'en_US',
    redirectAfterAccountLoginUrl: SSO_EMBED,
    service: SSO_EMBED,
  }).toString()}`,
  /** Origins the sign-in window may navigate to: Garmin's SSO and the Cloudflare challenge frame inside it. */
  signInOrigins: ['https://sso.garmin.com', 'https://challenges.cloudflare.com'],
  tokenUrl: 'https://diauth.garmin.com/di-oauth2-service/oauth/token',
  ticketGrant: 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket',
  // Garmin has renamed the app's client over time; sign-in takes the first one Garmin accepts.
  clientIds: [
    'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
    'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
    'GARMIN_CONNECT_MOBILE_ANDROID_DI',
    'GARMIN_CONNECT_MOBILE_IOS_DI',
  ],
  appHeaders: {
    'User-Agent': 'GCM-Android-5.23',
    'X-Garmin-User-Agent':
      'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
    'X-Garmin-Paired-App-Version': '10861',
    'X-Garmin-Client-Platform': 'Android',
    'X-App-Ver': '10861',
    'X-Lang': 'en',
    'X-GCExperience': 'GC5',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  uploadUrl: `${CONNECTAPI}/upload-service/upload`,
  activityListUrl: (start: number, limit: number, startDate: string): string =>
    `${CONNECTAPI}/activitylist-service/activities/search/activities?${new URLSearchParams({
      start: String(start),
      limit: String(limit),
      startDate,
    }).toString()}`,
  /** Original-file ZIP download, one per activity id. */
  downloadUrl: (activityId: number): string => `${CONNECTAPI}/download-service/files/activity/${activityId}`,
} as const;

/** The SSO service ticket, as it appears in a URL — or a success page's own HTML — on its way back. */
export const GARMIN_TICKET_RE = /[?&]ticket=(ST-[\w-]+)/;

const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const ACTIVITY_PAGE = 100;
const RECONNECT = 'press Connect Garmin on the profile to sign in again';

/** The rider's saved Garmin login: a DI token pair. The path predates the token flow; the name stays. */
export function garminLoginStatePath(dataDir: string, riderId: string): string {
  return join(dataDir, 'garmin', `${riderId}.json`);
}

const tokensSchema = z.object({
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  accessExpiresAt: z.number(),
  refreshToken: z.string().min(1),
  refreshExpiresAt: z.number().optional(),
});
export type GarminTokens = z.infer<typeof tokensSchema>;

// Garmin's DI token answer. A refresh may leave out the refresh token when it does not rotate it.
const grantSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().positive().optional(),
});

export type GarminFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LoggerLike {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Code Garmin puts on a duplicate in `detailedImportResult.failures`; the file is already there. */
const DUPLICATE_CODE = 202;

/**
 * A 2xx upload answer can still refuse the file (a parse failure in `detailedImportResult.failures`)
 * or be a challenge page; null means Garmin took it (or already had it).
 */
function uploadFailure(text: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return `not a JSON answer: ${text.slice(0, 120)}`;
  }
  const failures = (body as { detailedImportResult?: { failures?: unknown } } | null)?.detailedImportResult?.failures;
  if (!Array.isArray(failures)) return null;
  for (const failure of failures) {
    const messages = (failure as { messages?: unknown } | null)?.messages;
    for (const message of Array.isArray(messages) ? messages : []) {
      const { code, content } = (message ?? {}) as { code?: unknown; content?: unknown };
      if (code !== DUPLICATE_CODE) return typeof content === 'string' ? content : `failure code ${String(code)}`;
    }
  }
  return null;
}

/** The activity list is a bare array; older answers wrap it in `results`. Anything else is an error, not 0 rides. */
function activityRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const results = (body as { results?: unknown } | null)?.results;
  if (Array.isArray(results)) return results;
  throw new Error('activitylist-service answered in an unknown shape');
}

function dateOnly(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function parseTokens(text: string): GarminTokens | null {
  try {
    const parsed = tokensSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * One POST to the DI token endpoint, made the way the Connect app makes it. A refusal (4xx short of a
 * rate limit) comes back as its status for the caller to judge; limits and outages throw. No abort signal
 * beyond the timeout: this POST rotates the refresh token, and its answer has to be written down.
 */
export async function grant(
  fetchFn: GarminFetch,
  now: number,
  clientId: string,
  form: Record<string, string>,
  previous?: GarminTokens,
): Promise<GarminTokens | number> {
  const res = await fetchFn(GARMIN.tokenUrl, {
    method: 'POST',
    headers: {
      ...GARMIN.appHeaders,
      Authorization: `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body: new URLSearchParams({ ...form, client_id: clientId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    await res.body?.cancel();
    return res.status;
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Garmin token service returned HTTP ${res.status}; try again later`);
  }
  const minted = grantSchema.safeParse(await res.json().catch(() => null));
  if (!minted.success) throw new Error('Garmin token service returned no access token');
  const { access_token: accessToken, expires_in: expiresIn, refresh_token: rotated, refresh_token_expires_in: refreshIn } =
    minted.data;
  // Without a new refresh token, the saved one stays good.
  const refreshing =
    rotated !== undefined
      ? { refreshToken: rotated, refreshExpiresAt: refreshIn === undefined ? undefined : now + refreshIn * 1000 }
      : previous && { refreshToken: previous.refreshToken, refreshExpiresAt: previous.refreshExpiresAt };
  if (!refreshing) throw new Error('Garmin token service returned no refresh token');
  return { clientId: issuedTo(accessToken) ?? clientId, accessToken, accessExpiresAt: now + expiresIn * 1000, ...refreshing };
}

// The access token (a JWT) names the client it was issued to; refreshes must present that client.
function issuedTo(accessToken: string): string | null {
  try {
    const claims = z
      .object({ client_id: z.string().min(1) })
      .safeParse(JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')));
    return claims.success ? claims.data.client_id : null;
  } catch {
    return null;
  }
}

/** Trades a sign-in's service ticket for a token pair and saves it; the first client id Garmin accepts wins. */
export async function exchangeTicket(
  tokensPath: string,
  ticket: string,
  fetchFn: GarminFetch = (url, init) => fetch(url, init),
): Promise<void> {
  let tokens: GarminTokens | number = 0;
  for (const clientId of GARMIN.clientIds) {
    tokens = await grant(fetchFn, Date.now(), clientId, {
      grant_type: GARMIN.ticketGrant,
      service_ticket: ticket,
      service_url: SSO_EMBED,
    });
    if (typeof tokens !== 'number') break;
  }
  if (typeof tokens === 'number') {
    throw new Error(`Garmin would not trade the sign-in for tokens (HTTP ${tokens}); sign in again`);
  }
  await writeTokens(tokensPath, tokens);
}

// The token file is the whole credential: written under a temporary name so a crash cannot leave half a
// file, 0600 inside a 0700 directory, and flushed before the rename so a power cut cannot empty it.
async function writeTokens(path: string, tokens: GarminTokens): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = join(dir, `.tokens.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(tokens), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Garmin Connect through the rider's saved DI token pair: FIT uploads and the history pull. The access
 * token is renewed when it has expired or Garmin answers 401; failures are thrown as descriptive Errors and
 * are never fatal to the ride pipeline (the upload queue marks rides failed instead).
 */
export class GarminConnector {
  /** Refreshes run one at a time: two at once would spend the same refresh token and sign the rider out. */
  #refreshing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly log: LoggerLike,
    private readonly fetchFn: GarminFetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  loginStatePath(riderId: string): string {
    return garminLoginStatePath(this.dataDir, riderId);
  }

  hasLogin(riderId: string): boolean {
    try {
      return parseTokens(readFileSync(this.loginStatePath(riderId), 'utf8')) !== null;
    } catch {
      return false;
    }
  }

  /** Uploads a finalized FIT file. Garmin answers 409 for a file it already has; that counts as uploaded. */
  async uploadFit(riderId: string, fitPath: string): Promise<void> {
    if (!existsSync(fitPath)) {
      throw new Error(`FIT file not found: ${fitPath}`);
    }
    const data = await readFile(fitPath);
    const name = basename(fitPath);
    try {
      const res = await this.call(riderId, GARMIN.uploadUrl, 'application/json', REQUEST_TIMEOUT_MS, () => {
        const form = new FormData();
        form.append('file', new Blob([data]), name);
        return { method: 'POST', body: form };
      });
      if (res.status === 409) {
        await res.body?.cancel();
        this.log.info(`garmin upload: already on Garmin: ${fitPath}`);
        return;
      }
      if (!res.ok) {
        throw new Error(`upload-service returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const failure = uploadFailure(await res.text());
      if (failure !== null) throw new Error(`upload-service answered HTTP ${res.status} but did not take the file: ${failure}`);
      this.log.info(`garmin upload ok: ${fitPath}`);
    } catch (err) {
      throw new Error(`Garmin FIT upload failed for ${fitPath}: ${errorMessage(err)}`);
    }
  }

  /** Original FIT/ZIP buffers for the rider's activities started within `sinceDays`. */
  async pullRecentActivities(riderId: string, sinceDays: number): Promise<Buffer[]> {
    const startDate = dateOnly(new Date(this.now() - sinceDays * 24 * 60 * 60 * 1000));
    const activityIds: number[] = [];
    for (let start = 0; ; start += ACTIVITY_PAGE) {
      const res = await this.call(riderId, GARMIN.activityListUrl(start, ACTIVITY_PAGE, startDate), 'application/json', REQUEST_TIMEOUT_MS);
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`activitylist-service returned HTTP ${res.status}`);
      }
      const body = (await res.json()) as unknown;
      const rows = activityRows(body);
      for (const row of rows) {
        const id = (row as { activityId?: unknown } | null)?.activityId;
        if (typeof id === 'number') activityIds.push(id);
      }
      if (rows.length < ACTIVITY_PAGE) break;
    }
    this.log.info(`garmin history pull: ${activityIds.length} activities since ${sinceDays} days`);
    const buffers: Buffer[] = [];
    for (const activityId of activityIds) {
      const res = await this.call(riderId, GARMIN.downloadUrl(activityId), '*/*', DOWNLOAD_TIMEOUT_MS);
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`failed to download Garmin activity ${activityId}: download-service returned HTTP ${res.status}`);
      }
      buffers.push(Buffer.from(await res.arrayBuffer()));
    }
    return buffers;
  }

  /** One bearer request on connectapi; renews the access token first when expired, and once on a 401. */
  private async call(
    riderId: string,
    url: string,
    accept: string,
    timeoutMs: number,
    init: () => RequestInit = () => ({}),
  ): Promise<Response> {
    let tokens = await this.readTokens(riderId);
    if (tokens.accessExpiresAt <= this.now()) tokens = await this.refresh(riderId, tokens);
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, {
        ...init(),
        headers: { ...GARMIN.appHeaders, Accept: accept, Authorization: `Bearer ${tokens.accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 401) return res;
      await res.body?.cancel();
      if (attempt > 0) throw new Error(`Garmin refused the saved login (HTTP 401); ${RECONNECT}`);
      tokens = await this.refresh(riderId, tokens);
    }
  }

  private refresh(riderId: string, stale: GarminTokens): Promise<GarminTokens> {
    const next = this.#refreshing.catch(() => undefined).then(() => this.refreshNow(riderId, stale));
    this.#refreshing = next;
    return next;
  }

  private async refreshNow(riderId: string, stale: GarminTokens): Promise<GarminTokens> {
    const current = await this.readTokens(riderId);
    // Another call or a new sign-in already renewed the pair: use it rather than spend a retired token.
    if (current.accessToken !== stale.accessToken && current.accessExpiresAt > this.now()) return current;
    const renewed = await grant(
      this.fetchFn,
      this.now(),
      current.clientId,
      { grant_type: 'refresh_token', refresh_token: current.refreshToken },
      current,
    );
    if (typeof renewed === 'number') {
      throw new Error(`Garmin turned down the saved login (HTTP ${renewed}); ${RECONNECT}`);
    }
    // A sign-in that landed during the grant is the newer login: keep it, drop the pair just minted.
    const onDisk = await this.readTokens(riderId);
    if (onDisk.refreshToken !== current.refreshToken) return onDisk;
    // Garmin has already retired the old refresh token, so the new pair is on disk before anything uses it.
    await writeTokens(this.loginStatePath(riderId), renewed);
    return renewed;
  }

  private async readTokens(riderId: string): Promise<GarminTokens> {
    let text: string;
    try {
      text = await readFile(this.loginStatePath(riderId), 'utf8');
    } catch {
      throw new Error(`No Garmin login for rider ${riderId}; press Connect Garmin on the profile`);
    }
    const tokens = parseTokens(text);
    if (tokens === null) throw new Error(`The saved Garmin login for rider ${riderId} is unreadable; ${RECONNECT}`);
    return tokens;
  }
}
