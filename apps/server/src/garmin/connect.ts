import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { chromium, type Page } from 'playwright';

/**
 * Garmin churn point — update here.
 *
 * Every Garmin URL and selector used by the connector lives in this block.
 * The Garmin Connect web app changes markup and endpoints without notice;
 * when a flow breaks, fix it here — nothing else depends on these internals.
 */
export const GARMIN = {
  /** Sign-in entry; Connect forwards to SSO and back to the /app dashboard. */
  signInUrl: 'https://connect.garmin.com/signin/?service=https%3A%2F%2Fconnect.garmin.com%2Fapp%2F',
  /** Signed-in Connect page. Connect now redirects /modern/ to /app/; accept both. */
  dashboardUrl: /^https:\/\/connect\.garmin\.com\/(app|modern)\//,
  /** Any signed-in /app page; it carries the CSRF meta tag the gc-api needs. */
  appUrl: 'https://connect.garmin.com/app/import-data',
  csrfMetaSelector: 'meta[name="csrf-token"]',
  /** The web app's own JSON API, called from the signed-in page with its CSRF token. */
  uploadUrl: '/gc-api/upload-service/upload/.fit',
  activityListUrl: (startDate: string, endDate: string): string =>
    `/gc-api/activitylist-service/activities/search/activities?startDate=${startDate}&endDate=${endDate}&limit=1000&offset=0`,
  /** Original-file ZIP download, one per activity id. */
  downloadUrl: (activityId: number): string => `/gc-api/download-service/files/activity/${activityId}`,
} as const;

export function garminLoginStatePath(dataDir: string, riderId: string): string {
  return join(dataDir, 'garmin', `${riderId}.json`);
}

export interface LoggerLike {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dateOnly(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Playwright automation against Garmin Connect, one browser launch per call.
 * Uses the authenticated page context's own session (storageState on disk)
 * for both uploads and the history pull, so endpoint churn is contained
 * here; failures are thrown as descriptive Errors and are never fatal to the
 * ride pipeline (the upload queue marks rides failed instead).
 */
export class GarminConnector {
  constructor(
    private readonly dataDir: string,
    private readonly log: LoggerLike,
  ) {}

  loginStatePath(riderId: string): string {
    return garminLoginStatePath(this.dataDir, riderId);
  }

  hasLogin(riderId: string): boolean {
    return existsSync(this.loginStatePath(riderId));
  }

  /**
   * Uploads a finalized FIT file through the web app's upload-service, the
   * same call the import-data page makes. Garmin answers 409 for a file it
   * already has; that counts as uploaded, so retries are idempotent.
   */
  async uploadFit(riderId: string, fitPath: string): Promise<void> {
    if (!existsSync(fitPath)) {
      throw new Error(`FIT file not found: ${fitPath}`);
    }
    const bytes = [...readFileSync(fitPath)];
    const { page, csrf } = await this.openApp(riderId);
    try {
      const res = await page.evaluate(
        async ({ url, token, name, data }) => {
          const form = new FormData();
          form.append('file', new Blob([new Uint8Array(data)]), name);
          const r = await fetch(url, { method: 'POST', body: form, headers: { 'connect-csrf-token': token } });
          return { status: r.status, body: await r.text() };
        },
        { url: GARMIN.uploadUrl, token: csrf, name: basename(fitPath), data: bytes },
      );
      if (res.status === 409) {
        this.log.info(`garmin upload: already on Garmin: ${fitPath}`);
        return;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`upload-service returned HTTP ${res.status}: ${res.body.slice(0, 300)}`);
      }
      this.log.info(`garmin upload ok: ${fitPath}`);
    } catch (err) {
      throw new Error(`Garmin FIT upload failed for ${fitPath}: ${errorMessage(err)}`);
    } finally {
      await page.context().browser()?.close();
    }
  }

  /**
   * Pulls original FIT/ZIP buffers for the rider's activities started within
   * `sinceDays`, listed via the page's own activitylist-service XHR and
   * downloaded per-activity through download-service.
   */
  async pullRecentActivities(riderId: string, sinceDays: number): Promise<Buffer[]> {
    const { page, csrf } = await this.openApp(riderId);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - sinceDays * 24 * 60 * 60 * 1000);
      const listUrl = GARMIN.activityListUrl(dateOnly(start), dateOnly(end));
      const activityIds = await page.evaluate(async ({ url, token }): Promise<number[]> => {
        const res = await fetch(url, { headers: { 'connect-csrf-token': token } });
        if (!res.ok) throw new Error(`activitylist-service returned HTTP ${res.status}`);
        const body = (await res.json()) as { results?: Array<{ activityId?: unknown }> };
        return (body.results ?? []).flatMap((activity) =>
          typeof activity.activityId === 'number' ? [activity.activityId] : [],
        );
      }, { url: listUrl, token: csrf });
      this.log.info(`garmin history pull: ${activityIds.length} activities since ${sinceDays} days`);
      const buffers: Buffer[] = [];
      for (const activityId of activityIds) {
        buffers.push(await this.downloadActivity(page, csrf, activityId));
      }
      return buffers;
    } finally {
      await page.context().browser()?.close();
    }
  }

  /**
   * Headless page on a signed-in /app page with the rider's saved session, plus
   * the CSRF token gc-api calls need. An expired session lands on sign-in.
   */
  private async openApp(riderId: string): Promise<{ page: Page; csrf: string }> {
    const statePath = this.loginStatePath(riderId);
    if (!existsSync(statePath)) {
      throw new Error(`No Garmin login for rider ${riderId}; press Connect Garmin on the profile`);
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ storageState: statePath });
      const page = await context.newPage();
      await page.goto(GARMIN.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (!GARMIN.dashboardUrl.test(page.url())) {
        throw new Error('Garmin login expired; press Reconnect on the profile');
      }
      const csrf = await page
        .locator(GARMIN.csrfMetaSelector)
        .getAttribute('content', { timeout: 30_000 });
      if (!csrf) throw new Error('Garmin page has no CSRF token');
      return { page, csrf };
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  private async downloadActivity(page: Page, csrf: string, activityId: number): Promise<Buffer> {
    try {
      const bytes = await page.evaluate(async ({ url, token }): Promise<number[]> => {
        const res = await fetch(url, { headers: { 'connect-csrf-token': token } });
        if (!res.ok) throw new Error(`download-service returned HTTP ${res.status}`);
        return Array.from(new Uint8Array(await res.arrayBuffer()));
      }, { url: GARMIN.downloadUrl(activityId), token: csrf });
      return Buffer.from(bytes);
    } catch (err) {
      throw new Error(`failed to download Garmin activity ${activityId}: ${errorMessage(err)}`);
    }
  }
}
