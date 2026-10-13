// Closing a test's ports, workers and windows after it, however it ends.

/**
 * Runs `close` after the test `t`, a timeout too (a `finally` would wait on
 * a hung await). node:test keeps every hook until the run ends, so the hook
 * holds `close` (and what it closes over) in a slot it clears once run.
 * @param {{ after(fn: () => any): void }} t
 * @param {() => any} close
 */
export function closeAfter(t, close) {
  /** @type {{ close: (() => any) | null }} */
  const slot = { close };
  t.after(() => {
    const run = slot.close;
    slot.close = null;
    return run?.();
  });
}
