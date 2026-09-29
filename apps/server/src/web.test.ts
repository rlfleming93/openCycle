import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerWeb, resolveWebDir } from './web.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

/** A temp dir holding a minimal built client: index.html + one hashed asset. */
function makeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencycle-web-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX_HTML);
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("openCycle");\n');
  return dir;
}

async function buildApp(webDir: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerWeb(app, webDir);
  await app.ready();
  return app;
}

describe('resolveWebDir', () => {
  it('never serves the repo build in development', () => {
    const repoDist = makeWebDir();
    expect(resolveWebDir({}, repoDist)).toBeUndefined();
    expect(resolveWebDir({ NODE_ENV: 'development' }, repoDist)).toBeUndefined();
  });

  it('serves the repo build in production', () => {
    const repoDist = makeWebDir();
    expect(resolveWebDir({ NODE_ENV: 'production' }, repoDist)).toBe(repoDist);
  });

  it('serves nothing in production without a build', () => {
    expect(resolveWebDir({ NODE_ENV: 'production' }, join(tmpdir(), 'opencycle-no-such-dist'))).toBeUndefined();
  });

  it('lets OPENCYCLE_WEB_DIR win, in any environment', () => {
    const dir = makeWebDir();
    expect(resolveWebDir({ OPENCYCLE_WEB_DIR: dir })).toBe(dir);
    expect(resolveWebDir({ NODE_ENV: 'development', OPENCYCLE_WEB_DIR: dir })).toBe(dir);
  });

  it('ignores a dir without an index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencycle-web-'));
    tempDirs.push(dir);
    expect(resolveWebDir({ OPENCYCLE_WEB_DIR: dir })).toBeUndefined();
  });
});

describe('static web serving', () => {
  it('serves index.html at the root', async () => {
    const app = await buildApp(makeWebDir());
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe(INDEX_HTML);
    await app.close();
  });

  it('serves hashed assets with their own content type', async () => {
    const app = await buildApp(makeWebDir());
    const res = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).toContain('openCycle');
    await app.close();
  });

  it('falls back to index.html for client routes', async () => {
    const app = await buildApp(makeWebDir());
    for (const url of ['/voyage', '/history/6f1b2c3d-0000-4000-8000-abcdefabcdef', '/profiles?tab=ftp']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toBe(INDEX_HTML);
    }
    await app.close();
  });

  it('keeps 404s for the API and the socket path', async () => {
    const app = await buildApp(makeWebDir());
    for (const url of ['/api/nope', '/api/rides/nope/nothing', '/ws']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json<{ error: string }>().error).toContain('not found');
    }
    await app.close();
  });

  it('404s a missing asset instead of answering HTML', async () => {
    const app = await buildApp(makeWebDir());
    const res = await app.inject({ method: 'GET', url: '/assets/app-gone.js' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('id="root"');
    await app.close();
  });

  it('does not fall back for non-GET methods', async () => {
    const app = await buildApp(makeWebDir());
    const res = await app.inject({ method: 'POST', url: '/voyage' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
