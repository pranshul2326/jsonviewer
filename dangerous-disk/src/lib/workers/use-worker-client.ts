/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 19.1
//
// `useLazyWorkerClient` — a small Preact hook that lazily constructs a single
// `WorkerClient` over a worker and disposes it (terminating the underlying
// worker) on unmount.
//
// It exists so the tools that route heavy compute through a worker for
// Large_Documents (the Viewer's parse path, the Diff/Patch/Merge panels) do not
// each re-implement the "create-on-first-use + dispose-on-unmount" lifecycle
// that ConvertPanel/CodeGenPanel/QueryPanel already established inline.
//
// The worker is created by the caller-supplied `createWorker` factory. The
// factory MUST be written at the call site as
// `new Worker(new URL('../path/to/foo.worker.ts', import.meta.url), { type: 'module' })`
// so the Vite/Astro bundler can statically discover and emit the worker chunk;
// passing the URL indirectly would defeat that. The factory is only invoked the
// first time a job is dispatched, so a tool that never handles a Large_Document
// never spins up a worker.

import { useCallback, useEffect, useRef } from 'preact/hooks';
import { WorkerClient, type RunOptions } from './worker-client';
import type { WorkerOp } from './worker-protocol';

/**
 * A dispatch function bound to a lazily-created {@link WorkerClient}: it
 * forwards to `WorkerClient.run`, constructing the worker on first use.
 */
export type RunJob = <R = unknown, P = unknown>(
  op: WorkerOp,
  payload: P,
  options?: RunOptions,
) => Promise<R>;

/**
 * Provide a {@link RunJob} backed by a lazily-created, auto-disposed
 * `WorkerClient`.
 *
 * @param createWorker Factory that constructs the worker. Invoked at most once,
 *   on the first dispatch. Write it inline with `new URL(..., import.meta.url)`
 *   so the bundler can emit the worker chunk.
 */
export function useLazyWorkerClient(createWorker: () => Worker): RunJob {
  const clientRef = useRef<WorkerClient | null>(null);

  useEffect(() => {
    return () => {
      clientRef.current?.dispose(true);
      clientRef.current = null;
    };
  }, []);

  return useCallback<RunJob>((op, payload, options) => {
    if (!clientRef.current) {
      clientRef.current = new WorkerClient(createWorker());
    }
    return clientRef.current.run(op, payload, options);
    // `createWorker` is expected to be a stable inline closure; intentionally
    // not in deps so the client is never torn down/rebuilt mid-life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
