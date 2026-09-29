/**
 * Process-global GATT operation queue.
 *
 * macOS CoreBluetooth (and noble's bindings) only allow one GATT operation
 * in flight at a time across ALL peripherals, so every characteristic
 * read/write/subscribe and service discovery is serialized through this
 * queue. Notifications/indications flow freely outside the queue.
 *
 * Never-wedging invariant: the queue always advances. An op that has not
 * settled within GATT_OP_WATCHDOG_MS is abandoned — the tail moves on so
 * later ops still run, and this caller is rejected with a watchdog error.
 * The abandoned op's eventual settlement is ignored.
 */

const GATT_OP_WATCHDOG_MS = 20_000;

/**
 * Rejects `op` with a watchdog error if it has not settled within
 * `timeoutMs`. The eventual settlement of an abandoned op is ignored.
 */
function withWatchdog<T>(op: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(message));
    }, timeoutMs);
    op.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class GattQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Run `op` after every previously queued operation has settled. */
  run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.tail.then(op, op);
    const raced = withWatchdog(
      result,
      GATT_OP_WATCHDOG_MS,
      `GATT op watchdog: op did not settle within ${GATT_OP_WATCHDOG_MS} ms`,
    );
    // The chain never rejects: op errors propagate to this caller only.
    this.tail = raced.catch(() => undefined);
    return raced;
  }
}

/** Module-level singleton: one GATT queue for the whole process. */
export const gattQueue = new GattQueue();
