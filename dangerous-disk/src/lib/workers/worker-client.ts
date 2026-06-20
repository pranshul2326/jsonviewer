// Feature: json-viewer-free
//
// `WorkerClient` — the main-thread side of the worker protocol defined in
// `worker-protocol.ts`. It turns the fire-and-forget `postMessage` channel into
// an ergonomic, promise-per-job API and keeps the UI responsive (Req 17.2).
//
// Responsibilities (see design.md "Worker Strategy" and Req 17.1–17.5):
//   - Post a tagged `{ jobId, op, payload }` request and return a `Promise`
//     keyed by `jobId`, resolving on the worker's `result` and rejecting on its
//     `error` (Req 17.5).
//   - Relay every `progress` message to an optional `onProgress` callback so the
//     UI can show a progress indicator that updates ≥1/sec (Req 17.3).
//   - Cancel superseded jobs: when a newer job is started for the same logical
//     operation (same `key`), the older job's promise is abandoned/rejected and
//     its later responses are ignored, so rapid edits don't queue stale work.
//   - Generate unique `jobId`s.
//
// The client depends only on a minimal structural `WorkerLike` interface, so a
// real DOM `Worker` *or* an injected fake can be supplied (testability). It does
// not construct any worker entrypoint itself — wiring concrete `*.worker.ts`
// files is task 9.2. A `defaultWorkerFactory` shows the Vite/Astro pattern
// callers can use, but it is never invoked unless a caller opts in.

import {
  isErrorResponse,
  isProgressResponse,
  isResultResponse,
  type WorkerOp,
  type WorkerRequest,
  type WorkerResponse,
} from './worker-protocol';

/**
 * The minimal slice of the DOM `Worker` API the client relies on. A real
 * `Worker` satisfies this structurally; tests can inject a lightweight fake.
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
  terminate(): void;
}

/** Options controlling a single `run` call. */
export interface RunOptions {
  /**
   * Logical operation key. Starting a new job with a key that already has an
   * in-flight job *supersedes* the older one: the older promise rejects with a
   * `JobCancelledError` and its later responses are ignored (Req 17.5). Omit to
   * let the job run independently (no supersession).
   */
  key?: string;
  /**
   * Called for every `progress` message the worker emits, with a completion
   * fraction in [0, 1]. The worker emits progress ≥1/sec for long jobs so this
   * fires at least that often (Req 17.3).
   */
  onProgress?: (progress: number) => void;
  /**
   * Optional external cancellation. Aborting rejects the job's promise with a
   * `JobCancelledError` and ignores any later responses.
   */
  signal?: AbortSignal;
}

/** Rejection reason used when a job is superseded or explicitly cancelled. */
export class JobCancelledError extends Error {
  constructor(
    /** The id of the cancelled job. */
    public readonly jobId: string,
    message = 'Job was cancelled',
  ) {
    super(message);
    this.name = 'JobCancelledError';
  }
}

/** Internal bookkeeping for a single in-flight job. */
interface PendingJob {
  readonly jobId: string;
  readonly key?: string;
  resolve(result: unknown): void;
  reject(reason: unknown): void;
  onProgress?: (progress: number) => void;
  /** Detaches any per-job listeners (e.g. an AbortSignal handler). */
  cleanup(): void;
}

/**
 * Promise-per-job client over a single worker.
 *
 * Construct with any `WorkerLike` — a real `Worker` in the app, or a fake in
 * tests. One `WorkerClient` multiplexes many concurrent jobs over the one
 * worker channel, routing each response to its originating promise by `jobId`.
 */
export class WorkerClient {
  private readonly worker: WorkerLike;
  private readonly pending = new Map<string, PendingJob>();
  /** Maps a logical operation key to the jobId currently in flight for it. */
  private readonly activeByKey = new Map<string, string>();
  private readonly handleMessage: (event: { data: unknown }) => void;
  private seq = 0;
  private disposed = false;

  constructor(worker: WorkerLike) {
    this.worker = worker;
    this.handleMessage = (event) => this.onMessage(event.data);
    this.worker.addEventListener('message', this.handleMessage);
  }

  /**
   * Dispatch an operation to the worker and resolve with its result.
   *
   * @typeParam P - serializable payload type.
   * @typeParam R - serializable result type.
   */
  run<R = unknown, P = unknown>(
    op: WorkerOp,
    payload: P,
    options: RunOptions = {},
  ): Promise<R> {
    if (this.disposed) {
      return Promise.reject(new Error('WorkerClient has been disposed'));
    }

    const { key, onProgress, signal } = options;

    // Already-aborted signal: reject immediately without posting anything.
    if (signal?.aborted) {
      const jobId = this.nextJobId();
      return Promise.reject(new JobCancelledError(jobId));
    }

    const jobId = this.nextJobId();

    // Supersede any in-flight job sharing this logical key (Req 17.5).
    if (key !== undefined) {
      const supersededId = this.activeByKey.get(key);
      if (supersededId !== undefined) {
        this.cancelJob(
          supersededId,
          new JobCancelledError(
            supersededId,
            `Superseded by newer "${key}" job`,
          ),
        );
      }
      this.activeByKey.set(key, jobId);
    }

    return new Promise<R>((resolve, reject) => {
      let onAbort: (() => void) | undefined;

      const cleanup = (): void => {
        if (onAbort && signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      if (signal) {
        onAbort = () => {
          this.cancelJob(jobId, new JobCancelledError(jobId));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(jobId, {
        jobId,
        key,
        resolve: resolve as (result: unknown) => void,
        reject,
        onProgress,
        cleanup,
      });

      const request: WorkerRequest<P> = { jobId, op, payload };
      try {
        this.worker.postMessage(request);
      } catch (error) {
        // Posting failed (e.g. payload not clonable): reject and clean up.
        this.settle(jobId, () => reject(error));
      }
    });
  }

  /**
   * Abandon a specific in-flight job. Its promise rejects with
   * `JobCancelledError` (unless a different reason is given) and any later
   * responses for it are ignored.
   */
  cancel(jobId: string): void {
    this.cancelJob(jobId, new JobCancelledError(jobId));
  }

  /** Number of jobs currently awaiting a terminal response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Detach from the worker and reject every outstanding job. Does not terminate
   * the underlying worker unless `terminate` is true (the caller owns the
   * worker's lifecycle when it was injected).
   */
  dispose(terminate = false): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.worker.removeEventListener('message', this.handleMessage);

    for (const jobId of [...this.pending.keys()]) {
      this.cancelJob(jobId, new JobCancelledError(jobId, 'WorkerClient disposed'));
    }
    this.activeByKey.clear();

    if (terminate) {
      this.worker.terminate();
    }
  }

  /** Route an incoming worker message to its originating job. */
  private onMessage(data: unknown): void {
    if (!isWorkerResponse(data)) {
      return;
    }
    const job = this.pending.get(data.jobId);
    if (job === undefined) {
      // Unknown or already-settled/cancelled job: ignore (Req 17.5).
      return;
    }

    if (isProgressResponse(data)) {
      job.onProgress?.(data.progress);
      return;
    }

    if (isResultResponse(data)) {
      this.settle(data.jobId, () => job.resolve(data.result));
      return;
    }

    if (isErrorResponse(data)) {
      this.settle(data.jobId, () =>
        job.reject(new Error(data.error.message)),
      );
    }
  }

  /** Reject and forget a job (used for supersession, abort, and disposal). */
  private cancelJob(jobId: string, reason: unknown): void {
    const job = this.pending.get(jobId);
    if (job === undefined) {
      return;
    }
    this.settle(jobId, () => job.reject(reason));
  }

  /**
   * Run a settling action (resolve or reject) exactly once, then remove all
   * bookkeeping for the job so later responses are ignored.
   */
  private settle(jobId: string, action: () => void): void {
    const job = this.pending.get(jobId);
    if (job === undefined) {
      return;
    }
    this.pending.delete(jobId);
    if (job.key !== undefined && this.activeByKey.get(job.key) === jobId) {
      this.activeByKey.delete(job.key);
    }
    job.cleanup();
    action();
  }

  /** Generate a process-unique job id. */
  private nextJobId(): string {
    this.seq += 1;
    return `job-${Date.now().toString(36)}-${this.seq.toString(36)}-${randomSuffix()}`;
  }
}

/** A short, collision-resistant random suffix for job ids. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Runtime check that an unknown message is a well-formed `WorkerResponse`. */
function isWorkerResponse(data: unknown): data is WorkerResponse {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const candidate = data as { jobId?: unknown; kind?: unknown };
  return (
    typeof candidate.jobId === 'string' &&
    (candidate.kind === 'result' ||
      candidate.kind === 'progress' ||
      candidate.kind === 'error')
  );
}

/**
 * Reference factory showing how a concrete worker is constructed under the
 * Vite/Astro module-worker config (see `astro.config.mjs`). Task 9.2 will add
 * the actual `*.worker.ts` entrypoints; until then this is illustrative and is
 * never called by the client itself.
 *
 * @example
 *   const worker = defaultWorkerFactory(
 *     new URL('./parse.worker.ts', import.meta.url),
 *   );
 *   const client = new WorkerClient(worker);
 */
export function defaultWorkerFactory(url: URL): Worker {
  return new Worker(url, { type: 'module' });
}
