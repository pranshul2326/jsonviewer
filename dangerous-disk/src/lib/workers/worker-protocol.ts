// Feature: json-viewer-free
//
// The Web Worker message protocol shared by the main thread (`worker-client.ts`)
// and every worker entrypoint (`*.worker.ts`, built in task 9.2).
//
// Design (see design.md "Worker Strategy" and Req 17.1–17.5):
//   - Every job is a *tagged* request `{ jobId, op, payload }`. The `op`
//     discriminates which `json-core` / converter / codegen / query function the
//     worker runs; `payload` carries that function's serializable inputs.
//   - A worker replies with *exactly one* terminal message — `result` or
//     `error` — and *zero or more* `progress` messages emitted while it works
//     (the client relays these ≥1/sec for long jobs, Req 17.3).
//   - Every message is keyed by `jobId` so the client can route concurrent jobs
//     and drop responses for superseded/cancelled jobs (Req 17.5).
//
// All shapes here are intentionally structured-clone-safe: only strings,
// numbers, booleans, null, plain arrays, and plain objects cross the
// `postMessage` boundary. No functions, class instances, or `JsonNode` graphs
// with cyclic identity are sent — workers exchange raw text/JSON-compatible
// values and reconstruct models internally.

/**
 * The set of operations a worker can perform. Each maps to a pure function in
 * the shared core layer (parsing, semantic diff, RFC 6902 patch generation,
 * three-way merge, format conversion, code generation, expression querying).
 *
 * Matches design.md's worker strategy: `op ∈ parse | validate | diff | patch |
 * merge | convert | codegen | query`.
 */
export type WorkerOp =
  | 'parse'
  | 'validate'
  | 'diff'
  | 'patch'
  | 'merge'
  | 'convert'
  | 'codegen'
  | 'query';

/**
 * A request posted from the main thread to a worker.
 *
 * @typeParam P - the serializable payload type for the given operation.
 */
export interface WorkerRequest<P = unknown> {
  /** Unique id correlating this request with its responses. */
  jobId: string;
  /** Which operation the worker should perform. */
  op: WorkerOp;
  /** Serializable inputs for the operation (structured-clone-safe). */
  payload: P;
}

/** Discriminant tags for the three response message kinds. */
export type WorkerResponseKind = 'result' | 'progress' | 'error';

/**
 * Terminal success message: the worker finished and produced a result.
 *
 * @typeParam R - the serializable result type for the given operation.
 */
export interface WorkerResultResponse<R = unknown> {
  jobId: string;
  kind: 'result';
  /** The operation's serializable output. */
  result: R;
}

/**
 * Non-terminal progress message. A worker may emit any number of these before
 * its terminal message; the client relays them to an optional `onProgress`
 * callback at least once per second for long-running jobs (Req 17.3).
 */
export interface WorkerProgressResponse {
  jobId: string;
  kind: 'progress';
  /** Completion fraction in the inclusive range [0, 1]. */
  progress: number;
}

/** A serializable description of a worker-side failure. */
export interface WorkerErrorPayload {
  /** Human-readable reason for the failure (Req 17.5). */
  message: string;
}

/**
 * Terminal failure message: the worker could not complete the job. The client
 * rejects the corresponding promise so the caller can restore the prior view
 * state (Req 17.5).
 */
export interface WorkerErrorResponse {
  jobId: string;
  kind: 'error';
  error: WorkerErrorPayload;
}

/**
 * Any message a worker may post back to the main thread: zero or more
 * `progress` messages followed by exactly one `result` or `error`.
 *
 * @typeParam R - the serializable result type for `result` responses.
 */
export type WorkerResponse<R = unknown> =
  | WorkerResultResponse<R>
  | WorkerProgressResponse
  | WorkerErrorResponse;

/** Type guard: is this response the terminal success message? */
export function isResultResponse<R>(
  response: WorkerResponse<R>,
): response is WorkerResultResponse<R> {
  return response.kind === 'result';
}

/** Type guard: is this response a non-terminal progress message? */
export function isProgressResponse(
  response: WorkerResponse,
): response is WorkerProgressResponse {
  return response.kind === 'progress';
}

/** Type guard: is this response the terminal failure message? */
export function isErrorResponse(
  response: WorkerResponse,
): response is WorkerErrorResponse {
  return response.kind === 'error';
}
