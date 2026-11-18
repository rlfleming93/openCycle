import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { chromium, type Browser, type Page, type Response } from 'playwright';

import { GARMIN, GARMIN_TICKET_RE, exchangeTicket, garminLoginStatePath } from './connect.js';

export type GarminLoginProgress = 'installing' | 'running';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;
const NAV_TIMEOUT_MS = 60_000;
/** What Garmin's success redirect is answered with, so no request spends the single-use ticket first. */
const SIGNED_IN_PAGE = '<p>Signed in to Garmin. This window closes by itself.</p>';

async function installChromium(): Promise<void> {
  const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'install', 'chromium'], { stdio: 'inherit' });
  const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  if (code === 0) return;
  const outcome = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
  throw new Error(`Playwright Chromium install failed (${outcome})`);
}

/**
 * Headed, always: Garmin answers a headless browser with HTTP 427. The rider's own Chrome first; the
 * bundled Chromium (installed on first use) only when Chrome is not installed.
 */
async function launchBrowser(onProgress: (state: GarminLoginProgress) => void): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome', headless: false });
  } catch (err) {
    if (!/distribution 'chrome' is not found/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  if (!existsSync(chromium.executablePath())) {
    onProgress('installing');
    await installChromium();
    if (!existsSync(chromium.executablePath())) {
      throw new Error('Playwright Chromium is still missing after installation');
    }
  }
  return await chromium.launch({ headless: false });
}

function isSignInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && (GARMIN.signInOrigins as readonly string[]).includes(parsed.origin);
  } catch {
    return false;
  }
}

/** An open Garmin sign-in window. `ticket()` settles once: with the SSO ticket, or when the sign-in ends without one. */
export interface GarminSignIn {
  page: Page;
  /** Garmin's answer to the sign-in page itself; a 427 or 429 means Garmin refused this browser. */
  response: Response | null;
  ticket(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Opens Garmin's sign-in page and watches for the service ticket. Navigation is held to Garmin's SSO and
 * Cloudflare's challenge frame. The ticket is single use, so it is taken off the redirect response before
 * Chrome follows it (CDP Fetch at the response stage; Playwright routing never sees redirect targets),
 * off a navigation URL, or off a success page's HTML — whichever comes first.
 */
export async function openGarminSignIn(onProgress: (state: GarminLoginProgress) => void): Promise<GarminSignIn> {
  const browser = await launchBrowser(onProgress);
  const close = async (): Promise<void> => {
    await browser.close().catch(() => undefined);
  };
  try {
    const context = await browser.newContext({ viewport: null, acceptDownloads: false });
    const page = await context.newPage();
    // The server's lib target predates Promise.withResolvers.
    let resolveTicket!: (ticket: string) => void;
    let rejectTicket!: (err: Error) => void;
    const ticketPromise = new Promise<string>((resolve, reject) => {
      resolveTicket = resolve;
      rejectTicket = reject;
    });
    const found = { promise: ticketPromise, resolve: resolveTicket, reject: rejectTicket };
    void found.promise.catch(() => undefined);
    let ticket = '';
    const capture = (text: string | null): boolean => {
      const candidate = text === null ? null : (GARMIN_TICKET_RE.exec(text)?.[1] ?? null);
      if (candidate === null || ticket !== '') return false;
      ticket = candidate;
      found.resolve(ticket);
      return true;
    };
    const leftGarmin = (url: string): void => {
      found.reject(new Error(`Garmin sign-in left Garmin's pages (${new URL(url).origin}); the window was closed`));
    };

    // A second window would escape the navigation guard below.
    context.on('page', (opened) => {
      if (opened !== page) void opened.close().catch(() => undefined);
    });
    page.on('close', () => found.reject(new Error('Garmin sign-in window closed before signing in')));

    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      if (!request.isNavigationRequest() && request.resourceType() !== 'document') return await route.continue();
      if (!isSignInUrl(url)) {
        leftGarmin(url);
        return await route.abort();
      }
      if (capture(url)) return await route.fulfill({ contentType: 'text/html', body: SIGNED_IN_PAGE });
      return await route.continue();
    });

    const cdp = await context.newCDPSession(page);
    cdp.on('Fetch.requestPaused', (event) => {
      void (async () => {
        const location = event.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;
        const target = location === undefined ? null : URL.parse(location, event.request.url)?.toString() ?? null;
        if (target !== null && capture(target)) {
          await cdp.send('Fetch.fulfillRequest', {
            requestId: event.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'text/html' }],
            body: Buffer.from(SIGNED_IN_PAGE).toString('base64'),
          });
        } else if (target !== null && !isSignInUrl(target)) {
          leftGarmin(target);
          await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' });
        } else {
          await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        }
      })().catch(() => undefined);
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] });

    // Armed before the first navigation: the ticket can ride on any document answer, URL or HTML.
    void page
      .waitForResponse(
        async (res) => {
          const body = res.request().resourceType() === 'document' ? await res.text().catch(() => '') : '';
          return capture(res.url()) || capture(body);
        },
        { timeout: SIGN_IN_TIMEOUT_MS },
      )
      .catch(() => found.reject(new Error('Garmin sign-in ended without a ticket (window closed or 15 minutes passed)')));

    const response = await page.goto(GARMIN.signInUrl, { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS });
    const status = response?.status();
    if (status === 427 || status === 429) {
      throw new Error(`Garmin refused the sign-in page (HTTP ${status}); try again in a while`);
    }
    return { page, response, ticket: () => found.promise, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Signs a rider in to Garmin by hand and saves the token pair to `garminLoginStatePath`. */
export async function runGarminLogin(
  dataDir: string,
  riderId: string,
  onProgress: (state: GarminLoginProgress) => void,
): Promise<void> {
  const signIn = await openGarminSignIn(onProgress);
  onProgress('running');
  try {
    await exchangeTicket(garminLoginStatePath(dataDir, riderId), await signIn.ticket());
  } finally {
    await signIn.close();
  }
}
