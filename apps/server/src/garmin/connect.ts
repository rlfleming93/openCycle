import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Page } from 'playwright';

/**
 * Garmin churn point — update here.
 *
 * Every Garmin URL and selector used by the connector lives in this block.
 * The Garmin Connect web app changes markup and endpoints without notice;
 * when a flow breaks, fix it here — nothing else depends on these internals.
 */
export const GARMIN = {
  /** SSO sign-in entry; the login script drives this in a headed browser. */
  signInUrl: 'https://sso.garmin.com/sso/signin?service=https%3A%2F%2Fconnect.garmin.com%2Fmodern%2F',
  /** Modern dashboard: the login script waits for this URL after sign-in. */
  dashboardUrlGlob: 'https://connect.garmin.com/modern/**',
  /** Upload page: FIT file picker, import button, and outcome indicators. */
  importDataUrl: 'https://connect.garmin.com/modern/import-data',
  fileInputSelector: 'input[type="file"]',
  uploadButtonSelector: 'button:has-text("Import")',
  uploadSuccessSelector: 'text=Success',
  uploadFailureSelector: 'text=problem',
  /** History pull: activitylist-service XHR fetched from the page context. */
  activityListUrl: (startDate: string, endDate: string): string =>
    `https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities?startDate=${startDate}&endDate=${endDate}&limit=1000&offset=0`,
  /** Original-file ZIP download, one per activity id. */
  downloadUrl: (activityId: number): string =>
    `https://connect.garmin.com/modern/proxy/download-service/files/activity/${activityId}`,
} as const;

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
    return join(this.dataDir, 'garmin', `${riderId}.json`);
  }

  hasLogin(riderId: string): boolean {
    return existsSync(this.loginStatePath(riderId));
  }

  /**
   * Uploads a finalized FIT file through the real import-data page: file
   * picker → import button → success indicator (60 s cap). Throws with a
   * descriptive message on missing login state or any step failure.
   */
  async uploadFit(riderId: string, fitPath: string): Promise<void> {
    if (!existsSync(fitPath)) {
      throw new Error(`FIT file not found: ${fitPath}`);
    }
    const page = await this.openPage(riderId);
    try {
      await page.goto(GARMIN.importDataUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector(GARMIN.fileInputSelector, { timeout: 30_000 });
      await page.locator(GARMIN.fileInputSelector).first().setInputFiles(fitPath);
      await page.locator(GARMIN.uploadButtonSelector).first().click({ timeout: 30_000 });
      await page.waitForSelector(GARMIN.uploadSuccessSelector, { timeout: 60_000 });
      this.log.info(`garmin upload ok: ${fitPath}`);
    } catch (err) {
      let detail = errorMessage(err);
      try {
        if ((await page.locator(GARMIN.uploadFailureSelector).count()) > 0) {
          detail = 'Garmin reported an import problem';
        }
      } catch {
        // Page closed mid-flight; keep the original error.
      }
      throw new Error(`Garmin FIT upload failed for ${fitPath}: ${detail}`);
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
    const page = await this.openPage(riderId);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - sinceDays * 24 * 60 * 60 * 1000);
      const listUrl = GARMIN.activityListUrl(dateOnly(start), dateOnly(end));
      const activityIds = await page.evaluate(async (url: string): Promise<number[]> => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`activitylist-service returned HTTP ${res.status}`);
        const body = (await res.json()) as { results?: Array<{ activityId?: unknown }> };
        return (body.results ?? []).flatMap((activity) =>
          typeof activity.activityId === 'number' ? [activity.activityId] : [],
        );
      }, listUrl);
      this.log.info(`garmin history pull: ${activityIds.length} activities since ${sinceDays} days`);
      const buffers: Buffer[] = [];
      for (const activityId of activityIds) {
        buffers.push(await this.downloadActivity(page, activityId));
      }
      return buffers;
    } finally {
      await page.context().browser()?.close();
    }
  }

  /** Headless browser page carrying the rider's saved storage state. */
  private async openPage(riderId: string): Promise<Page> {
    const statePath = this.loginStatePath(riderId);
    if (!existsSync(statePath)) {
      throw new Error(
        `No Garmin login for rider ${riderId} (${statePath}); run pnpm garmin:login --rider ${riderId} first`,
      );
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ storageState: statePath });
      return await context.newPage();
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  private async downloadActivity(page: Page, activityId: number): Promise<Buffer> {
    try {
      const bytes = await page.evaluate(async (url: string): Promise<number[]> => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download-service returned HTTP ${res.status}`);
        return Array.from(new Uint8Array(await res.arrayBuffer()));
      }, GARMIN.downloadUrl(activityId));
      return Buffer.from(bytes);
    } catch (err) {
      throw new Error(`failed to download Garmin activity ${activityId}: ${errorMessage(err)}`);
    }
  }
}
