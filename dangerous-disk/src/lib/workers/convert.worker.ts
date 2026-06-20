// Feature: json-viewer-free
//
// `convert.worker.ts` — the dedicated module worker that runs format conversion
// off the main thread (Req 17.1, 17.4). It handles the `convert` op of the
// shared worker protocol (`worker-protocol.ts`).
//
// A single worker serves all four bidirectional converters; the payload selects
// which one via a `format` (`yaml | toml | xml | csv`) and a `direction`:
//
//   - `fromJson` — JSON text → the target format (`jsonToYaml`, `jsonToToml`,
//                  `jsonToXml`, `jsonToCsv`).
//   - `toJson`   — the source format → JSON text (`yamlToJson`, `tomlToJson`,
//                  `xmlToJson`, `csvToJson`).
//
// Every converter already returns a typed `{ ok, text } | { ok, error }`
// result rather than throwing for ordinary, user-correctable problems (invalid
// input, an unconvertible shape). That discriminated result is forwarded
// verbatim as the terminal `result` so the Converter panel can render either
// the converted text or the descriptive, located error (Req 13.4, 13.10) and
// leave the source unchanged. Only an unexpected exception becomes a terminal
// `error`.
//
// Each run posts `progress` 0 on entry and `progress` 1 immediately before its
// single terminal message.

import { jsonToYaml, yamlToJson } from '../converters/yaml';
import { jsonToToml, tomlToJson } from '../converters/toml';
import { jsonToXml, xmlToJson } from '../converters/xml';
import { jsonToCsv, csvToJson } from '../converters/csv';
import type {
  WorkerErrorResponse,
  WorkerProgressResponse,
  WorkerRequest,
  WorkerResultResponse,
} from './worker-protocol';

/** The four supported interchange formats. */
type ConvertFormat = 'yaml' | 'toml' | 'xml' | 'csv';

/** Conversion direction relative to JSON. */
type ConvertDirection = 'fromJson' | 'toJson';

/** Inputs for the `convert` op. */
interface ConvertPayload {
  /** The source text (JSON when `direction` is `fromJson`, else the format). */
  text: string;
  /** Which converter to use. */
  format: ConvertFormat;
  /** `fromJson` = JSON→format; `toJson` = format→JSON. */
  direction: ConvertDirection;
}

/**
 * The common shape every converter returns. `ConverterResult` (yaml/toml) and
 * `ConvertResult` (xml/csv) are structurally identical, so the dispatch table
 * can describe both with this one type.
 */
type AnyConvertResult =
  | { ok: true; text: string }
  | { ok: false; error: { message: string; line?: number; path?: string } };

/** Result payload for a `convert` op: the converter's own discriminated result. */
type ConvertResultPayload = AnyConvertResult;

/** Dispatch table keyed by `${direction}:${format}`. */
const CONVERTERS: Record<string, (text: string) => AnyConvertResult> = {
  'fromJson:yaml': jsonToYaml,
  'fromJson:toml': jsonToToml,
  'fromJson:xml': jsonToXml,
  'fromJson:csv': jsonToCsv,
  'toJson:yaml': yamlToJson,
  'toJson:toml': tomlToJson,
  'toJson:xml': xmlToJson,
  'toJson:csv': csvToJson,
};

/**
 * The slice of the dedicated-worker global scope this entrypoint uses. Declared
 * structurally so it type-checks under the DOM lib without the WebWorker lib.
 */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
}

const ctx = self as unknown as WorkerScope;

/** Post a non-terminal progress message (completion fraction in [0, 1]). */
function postProgress(jobId: string, progress: number): void {
  const message: WorkerProgressResponse = { jobId, kind: 'progress', progress };
  ctx.postMessage(message);
}

/** Post the single terminal success message for a job. */
function postResult<R>(jobId: string, result: R): void {
  const message: WorkerResultResponse<R> = { jobId, kind: 'result', result };
  ctx.postMessage(message);
}

/** Post the single terminal failure message for a job. */
function postError(jobId: string, message: string): void {
  const response: WorkerErrorResponse = {
    jobId,
    kind: 'error',
    error: { message },
  };
  ctx.postMessage(response);
}

/** Narrow an unknown message to a well-formed `WorkerRequest`. */
function asRequest(data: unknown): WorkerRequest | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const candidate = data as { jobId?: unknown; op?: unknown };
  if (typeof candidate.jobId !== 'string' || typeof candidate.op !== 'string') {
    return null;
  }
  return data as WorkerRequest;
}

ctx.addEventListener('message', (event) => {
  const request = asRequest(event.data);
  if (request === null) {
    return;
  }
  const { jobId, op } = request;

  try {
    postProgress(jobId, 0);

    if (op !== 'convert') {
      postError(jobId, `convert.worker received unsupported op "${op}".`);
      return;
    }

    const { text, format, direction } = request.payload as ConvertPayload;
    const convert = CONVERTERS[`${direction}:${format}`];
    if (convert === undefined) {
      postError(
        jobId,
        `Unsupported conversion: direction "${direction}", format "${format}".`,
      );
      return;
    }

    const result = convert(typeof text === 'string' ? text : '');
    postProgress(jobId, 1);
    postResult<ConvertResultPayload>(jobId, result);
  } catch (error) {
    postError(
      jobId,
      error instanceof Error && error.message
        ? error.message
        : 'The conversion failed unexpectedly.',
    );
  }
});
