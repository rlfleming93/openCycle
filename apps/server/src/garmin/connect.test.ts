import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GARMIN, GarminConnector, garminLoginStatePath, type GarminFetch, type GarminTokens } from './connect.js';

const NOW = 1_800_000_000_000;
const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('GarminConnector token rotation', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Garmin retires R1 the moment it issues R2: an upload that ran on A2 before R2 hit disk could lose it.
  it.each([
    ['expired access token', NOW - 1, ['token', 'upload']],
    ['401 from the upload', NOW + 3_600_000, ['upload', 'token', 'upload']],
  ])('%s: saves the rotated pair before the request that uses it', async (_name, accessExpiresAt, expectedCalls) => {
    dir = mkdtempSync(join(tmpdir(), 'opencycle-garmin-'));
    mkdirSync(join(dir, 'garmin'));
    const tokensPath = garminLoginStatePath(dir, 'r1');
    const old: GarminTokens = { clientId: 'C', accessToken: 'A1', accessExpiresAt, refreshToken: 'R1' };
    writeFileSync(tokensPath, JSON.stringify(old));
    const fitPath = join(dir, 'ride.fit');
    writeFileSync(fitPath, Buffer.from('fit bytes'));

    const calls: string[] = [];
    const fakeFetch: GarminFetch = async (url, init) => {
      const headers = init.headers as Record<string, string>;
      if (url === GARMIN.tokenUrl) {
        calls.push('token');
        expect(String(init.body)).toContain('refresh_token=R1');
        return Response.json({ access_token: 'A2', expires_in: 3600, refresh_token: 'R2', refresh_token_expires_in: 7_776_000 });
      }
      calls.push('upload');
      if (headers.Authorization === 'Bearer A1') return new Response(null, { status: 401 });
      expect(headers.Authorization).toBe('Bearer A2');
      expect(JSON.parse(readFileSync(tokensPath, 'utf8'))).toMatchObject({ accessToken: 'A2', refreshToken: 'R2' });
      return new Response('{}', { status: 201 });
    };

    await new GarminConnector(dir, silent, fakeFetch, () => NOW).uploadFit('r1', fitPath);

    expect(calls).toEqual(expectedCalls);
    expect(statSync(tokensPath).mode & 0o777).toBe(0o600);
  });
});
