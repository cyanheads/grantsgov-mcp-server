/**
 * @fileoverview Shared helpers for exercising failure paths: capturing a
 * rejection as the error the framework serializes, and draining the service's
 * retry backoff under fake timers.
 * @module tests/fixtures/harness
 */

import { vi } from 'vitest';

/** A thrown tool error: JSON-RPC code, message, and structured data. */
export type Failure = { code: number; message: string; data: Record<string, unknown> };

/** Awaits `call` and returns what it threw; fails the test when it resolves. */
export async function rejectionOf(call: () => unknown): Promise<Failure> {
  try {
    await call();
  } catch (err) {
    return err as Failure;
  }
  throw new Error('Expected the call to reject');
}

/**
 * Runs `call` with `setTimeout` faked, so the retry ladder's backoff sleeps
 * drain instantly instead of taking ~1.5 s of wall time per exhausted call.
 */
export async function drained<T>(call: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const outcome = call().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const settled = await outcome;
    if (!settled.ok) throw settled.error;
    return settled.value;
  } finally {
    vi.useRealTimers();
  }
}
