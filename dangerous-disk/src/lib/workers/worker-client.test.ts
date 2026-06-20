// Feature: json-viewer-free — WorkerClient dispatch integration tests
//
// Validates: Requirements 17.2, 17.3, 17.4, 17.5
//
// Req 17.2: "WHILE a Background_Worker is processing a document, THE Application
//  SHALL respond to any user input action within 100 milliseconds." — exercised
//  here as the client's ability to start a *new* job (a user input action) while
//  an older one is still in flight, immediately superseding/cancelling the
//  stale work so it never blocks the newer request.
// Req 17.3: "WHILE a Background_Worker is processing a document, THE Application
//  SHALL display a processing-progress indicator that updates at least once per
//  second." — exercised as the client relaying each worker `progress` message to
//  the `onProgress` callback, so a worker emitting >=1/sec drives >=1 callback/sec.
// Req 17.4: "WHEN processing of a Large_Document completes, THE Application SHALL
//  ... render the result in the active tool view." — exercised as a dispatched
//  job resolving with the worker's `result` payload.
// Req 17.5: "IF processing of a document fails on a Background_Worker, THEN THE
//  Application SHALL display an error message indicating the reason for failure
//  ..." — exercised as a worker `error` response rejecting the promise with a
//  reason, and superseded jobs being dropped (their late responses ignored).
//
// Real Web Workers aren't available under vitest + jsdom, so we inject a
// `FakeWorker` implementing the structural `WorkerLike` interface. It records
// every posted request (so tests can read the generated `jobId`) and lets the
// test drive the protocol by emitting `result` / `progress` / `error` messages
// back through the registered listeners — fully deterministic, with fake timers
// for the cadence assertions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkerClient,
  JobCancelledError,
  type WorkerLike,
} from './worker-client';
import type {
  WorkerErrorResponse,
  WorkerProgressResponse,
  WorkerRequest,
  WorkerResultResponse,
} from './worker-protocol';

/** A request as posted by the client over `postMessage`. */
type PostedRequest = WorkerRequest;

/**
 * Minimal in-memory stand-in for a DOM `Worker` that satisfies `WorkerLike`.
 *
 * It captures posted requests and exposes `emit*` driver helpers so a test can
 * play the worker's side of the protocol deterministically.
 */
class FakeWorker implements WorkerLike {
  /** Every request the client posted, in order. */
  readonly posted: PostedRequest[] = [];
  /** Whether `terminate()` was called. */
  terminated = false;

  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  postMessage(message: unknown): void {
    this.posted.push(message as PostedRequest);
  }

  addEventListener(
    _type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void {
    this.listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  // ---- test driver helpers (the "worker side" of the protocol) ----

  /** The jobId of the most recently posted request. */
  get lastJobId(): string {
    const last = this.posted[this.posted.length - 1];
    if (last === undefined) {
      throw new Error('FakeWorker: no request has been posted yet');
    }
    return last.jobId;
  }

  /** Deliver a raw message to every registered listener. */
  private deliver(data: unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data });
    }
  }

  emitResult(jobId: string, result: unknown): void {
    const message: WorkerResultResponse = { jobId, kind: 'result', result };
    this.deliver(message);
  }

  emitProgress(jobId: string, progress: number): void {
    const message: WorkerProgressResponse = { jobId, kind: 'progress', progress };
    this.deliver(message);
  }

  emitError(jobId: string, reason: string): void {
    const message: WorkerErrorResponse = {
      jobId,
      kind: 'error',
      error: { message: reason },
    };
    this.deliver(message);
  }
}

describe('WorkerClient dispatch integration', () => {
  let worker: FakeWorker;
  let client: WorkerClient;

  beforeEach(() => {
    worker = new FakeWorker();
    client = new WorkerClient(worker);
  });

  afterEach(() => {
    client.dispose();
  });

  it('resolves a dispatched job with the worker result payload (Req 17.4)', async () => {
    const payload = { text: '{"a":1}' };
    const expected = { ok: true, nodeCount: 1 };

    const promise = client.run('parse', payload);

    // The request reached the worker, tagged with a jobId and the op/payload.
    expect(worker.posted).toHaveLength(1);
    const request = worker.posted[0];
    expect(request.op).toBe('parse');
    expect(request.payload).toEqual(payload);
    expect(typeof request.jobId).toBe('string');

    // Worker finishes: the client resolves the promise with the result payload.
    worker.emitResult(request.jobId, expected);

    await expect(promise).resolves.toEqual(expected);
    expect(client.pendingCount).toBe(0);
  });

  it('relays progress at least once per second for a long-running job (Req 17.3)', async () => {
    vi.useFakeTimers();
    try {
      const progressValues: number[] = [];
      const promise = client.run('parse', { text: 'big' }, {
        onProgress: (p) => progressValues.push(p),
      });
      const { jobId } = worker.posted[0];

      // Simulate a worker that emits a progress message once per second for a
      // 3-second job. The client must relay each one to onProgress.
      const ticks = 3;
      for (let second = 1; second <= ticks; second += 1) {
        vi.advanceTimersByTime(1000);
        worker.emitProgress(jobId, second / ticks);
      }

      // At least one progress update per elapsed second (Req 17.3).
      expect(progressValues.length).toBeGreaterThanOrEqual(ticks);
      expect(progressValues).toEqual([1 / 3, 2 / 3, 1]);

      // Job then completes and the indicator can be removed.
      worker.emitResult(jobId, { done: true });
      await expect(promise).resolves.toEqual({ done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a superseded job when a newer job shares its key (Req 17.2, 17.5)', async () => {
    // First job for the "parse" key — represents an in-flight edit.
    const stale = client.run('parse', { text: 'v1' }, { key: 'parse' });
    const staleJobId = worker.posted[0].jobId;

    // A newer edit supersedes it (same key). The client must start the new job
    // immediately (responsive to input, Req 17.2) and cancel the old one.
    const fresh = client.run('parse', { text: 'v2' }, { key: 'parse' });
    const freshJobId = worker.posted[1].jobId;

    expect(freshJobId).not.toBe(staleJobId);

    // The superseded promise rejects with a cancellation reason.
    await expect(stale).rejects.toBeInstanceOf(JobCancelledError);

    // A late response for the superseded job is ignored (Req 17.5): it must not
    // resolve/settle anything nor disturb the fresh job.
    worker.emitResult(staleJobId, { stale: true });

    // The fresh job still resolves normally with its own result.
    worker.emitResult(freshJobId, { fresh: true });
    await expect(fresh).resolves.toEqual({ fresh: true });
    expect(client.pendingCount).toBe(0);
  });

  it('rejects the job promise with the reason from a worker error (Req 17.5)', async () => {
    const promise = client.run('parse', { text: 'oops' });
    const { jobId } = worker.posted[0];

    worker.emitError(jobId, 'Unexpected token } at position 7');

    await expect(promise).rejects.toThrow('Unexpected token } at position 7');
    // Indicator/bookkeeping cleared so the prior view can be restored.
    expect(client.pendingCount).toBe(0);
  });
});
