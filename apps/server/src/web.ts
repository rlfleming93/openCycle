import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Built web client shipped in the repo: apps/web/dist. */
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist/', import.meta.url));

/** Prefixes owned by the API and the WebSocket endpoint; never SPA-fallbacked. */
const RESERVED_PREFIXES = ['/api', '/ws'];

/**
 * Directory of the built UI to serve, or undefined for API-only mode.
 * OPENCYCLE_WEB_DIR wins (that is how the Mac app points at its own build);
 * otherwise the repo's apps/web/dist (defaultDir) is served when it exists
 * and the process runs in production (NODE_ENV=production).
 */
export function resolveWebDir(
  env: NodeJS.ProcessEnv = process.env,
  defaultDir: string = DEFAULT_WEB_DIR,
): string | undefined {
  const explicit = env.OPENCYCLE_WEB_DIR;
  if (explicit !== undefined && explicit !== '') {
    return existsSync(join(explicit, 'index.html')) ? explicit : undefined;
  }
  if (env.NODE_ENV !== 'production') return undefined;
  return existsSync(join(defaultDir, 'index.html')) ? defaultDir : undefined;
}

/**
 * Serves the built client from `webDir` on the same port as the API.
 * Unknown non-API GET paths return index.html so client-side routes
 * (/voyage, /history/<id>, …) survive a reload or a direct link; unknown
 * paths that look like files, and everything under /api or /ws, keep the
 * plain 404 so the API contract and missing-asset failures stay honest.
 */
export async function registerWeb(app: FastifyInstance, webDir: string): Promise<void> {
  // wildcard:false registers one route per existing file, which leaves
  // room for the fallback handler below instead of a catch-all that would
  // answer every unknown path with 404.
  await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    const [path = ''] = req.url.split('?', 1);
    const reserved = RESERVED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    // A dotted last segment is an asset request (.js, .css, .map, .png …):
    // answering it with HTML would surface as a MIME error instead of a
    // clean 404.
    const looksLikeFile = extname(path) !== '';
    if (req.method === 'GET' && !reserved && !looksLikeFile) {
      reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: `Route ${req.method}:${req.url} not found` });
  });
}
