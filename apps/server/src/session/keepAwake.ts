import { spawn, type ChildProcess } from 'node:child_process';

import type { SessionEngine } from './engine.js';

/**
 * Keeps the Mac's display (and so the screen saver) off while a session runs:
 * `caffeinate -d -i` from the first rider joining until the session ends. `-w`
 * ties it to this process, so a crashed server never leaves the Mac awake.
 */
export function attachKeepAwake(engine: SessionEngine, log: (message: string) => void): void {
  if (process.platform !== 'darwin') return;
  let caffeinate: ChildProcess | null = null;
  engine.on('event', (event) => {
    if (event.kind !== 'riderJoined' || caffeinate !== null) return;
    caffeinate = spawn('caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore' });
    caffeinate.on('error', (err) => log(`caffeinate failed: ${err.message}`));
  });
  engine.on('ended', () => {
    caffeinate?.kill();
    caffeinate = null;
  });
}
