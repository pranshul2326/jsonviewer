/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 16.1
//
// ConvertPanel — the Converter tool's bidirectional format converter
// (Req 13.4, 13.9, 13.10).
//
// It converts the JSON document to and from YAML, XML, CSV, and TOML, in BOTH
// directions, by dispatching the `convert` op to `convert.worker.ts` through the
// shared `WorkerClient`. Heavy work therefore runs off the main thread so the UI
// stays responsive (Req 13.9 — the performance budget is finalized in task 19.1,
// but the worker path is wired here).
//
// Behavior mapped to requirements:
//   • Both ways via workers — a `format` (yaml | xml | csv | toml) and a
//     `direction` (`fromJson` = JSON→format, `toJson` = format→JSON) select one
//     of the eight converters the worker dispatches by `${direction}:${format}`.
//   • Success — the converted text is rendered in the output pane.
//   • Failure (Req 13.4, 13.10) — the converter returns a typed, descriptive
//     error identifying the reason and, where determinable, the location (a
//     1-based line and/or a JSON path). That error is shown in place of output
//     and the SOURCE is left unchanged: a failed conversion never mutates the
//     source text or the shared `$document`.
//
// The JSON side is bound to the shared `$document` store so the document flows
// between the Viewer, Grid, and Converter tools (Req 21.5/21.6):
//   • `fromJson` reads the JSON to convert from `$document`.
//   • `toJson` converts user-supplied source text and offers to load the
//     resulting JSON into the shared document.
//
// The worker is created lazily and disposed on unmount. For testability the
// converter is injectable via the `convert` prop, so tests can exercise the
// panel without a real `Worker` (which Vite builds from `import.meta.url`).

import { useStore } from '@nanostores/preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { $document, setDocumentText } from '../../lib/stores/document';
import {
  JobCancelledError,
  WorkerClient,
} from '../../lib/workers/worker-client';

/** The four interchange formats the converter supports (Req 13). */
export type ConvertFormat = 'yaml' | 'xml' | 'csv' | 'toml';

/** Conversion direction relative to JSON. */
export type ConvertDirection = 'fromJson' | 'toJson';

/** Serializable inputs for the `convert` worker op. */
export interface ConvertPayload {
  /** Source text: JSON when `direction` is `fromJson`, else the source format. */
  text: string;
  /** Which converter to run. */
  format: ConvertFormat;
  /** `fromJson` = JSON→format; `toJson` = format→JSON. */
  direction: ConvertDirection;
}

/**
 * The discriminated result every converter returns (and the worker forwards
 * verbatim): the converted `text`, or a descriptive `error` with an optional
 * location. Structurally identical to the converters' own result types.
 */
export interface ConvertErrorInfo {
  /** Human-readable explanation of why the conversion failed. */
  message: string;
  /** 1-based line of the offending content, where determinable. */
  line?: number;
  /** JSON path (or path-like locator) of the offending content, where determinable. */
  path?: string;
}

export type ConvertResult =
  | { ok: true; text: string }
  | { ok: false; error: ConvertErrorInfo };

/** A converter function: dispatches a job and resolves with its typed result. */
export type ConvertFn = (
  payload: ConvertPayload,
  onProgress?: (progress: number) => void,
) => Promise<ConvertResult>;

/** Props for {@link ConvertPanel}. */
export interface ConvertPanelProps {
  /**
   * Inject a converter for testing. When omitted, a real `WorkerClient` over
   * `convert.worker.ts` is created lazily and used.
   */
  convert?: ConvertFn;
}

/** Display metadata for each format. */
const FORMATS: ReadonlyArray<{ id: ConvertFormat; label: string }> = [
  { id: 'yaml', label: 'YAML' },
  { id: 'xml', label: 'XML' },
  { id: 'csv', label: 'CSV' },
  { id: 'toml', label: 'TOML' },
] as const;

/** Lifecycle of a single conversion attempt. */
type Status = 'idle' | 'converting' | 'done' | 'error';

/**
 * The Converter panel. Selects a format and direction, runs the conversion in a
 * worker, and renders either the converted output or a descriptive, located
 * error — always leaving the source unchanged on failure.
 */
export default function ConvertPanel({ convert }: ConvertPanelProps) {
  const doc = useStore($document);

  const [format, setFormat] = useState<ConvertFormat>('yaml');
  const [direction, setDirection] = useState<ConvertDirection>('fromJson');
  // Source text for `toJson` (the format being converted into JSON). For
  // `fromJson` the source is the shared document and this is ignored.
  const [formatSource, setFormatSource] = useState('');

  const [output, setOutput] = useState('');
  const [error, setError] = useState<ConvertErrorInfo | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [copied, setCopied] = useState(false);

  // The source text fed to the converter, by direction. `fromJson` always reads
  // the live shared document so the converter reflects the current JSON.
  const sourceText = direction === 'fromJson' ? doc.text : formatSource;

  // ── Worker client (lazy, disposed on unmount) ───────────────────────────
  const clientRef = useRef<WorkerClient | null>(null);
  useEffect(() => {
    return () => {
      clientRef.current?.dispose(true);
      clientRef.current = null;
    };
  }, []);

  const runConvert = useCallback<ConvertFn>(
    (payload, onProgress) => {
      if (convert) return convert(payload, onProgress);
      if (!clientRef.current) {
        const worker = new Worker(
          new URL('../../lib/workers/convert.worker.ts', import.meta.url),
          { type: 'module' },
        );
        clientRef.current = new WorkerClient(worker);
      }
      // `key: 'convert'` supersedes any in-flight conversion so rapid edits or
      // option changes don't queue stale work (Req 17.5).
      return clientRef.current.run<ConvertResult, ConvertPayload>('convert', payload, {
        key: 'convert',
        onProgress,
      });
    },
    [convert],
  );

  // ── Convert on any change to source / format / direction (debounced) ─────
  useEffect(() => {
    setCopied(false);

    // Empty source: nothing to convert; clear any prior result/error.
    if (sourceText.trim() === '') {
      setOutput('');
      setError(null);
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('converting');

    const timer = setTimeout(() => {
      runConvert({ text: sourceText, format, direction })
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setOutput(result.text);
            setError(null);
            setStatus('done');
          } else {
            // Failure: surface the descriptive, located error and leave the
            // source unchanged (Req 13.4, 13.10). Clear stale output so a
            // mismatched previous result is never shown alongside the error.
            setOutput('');
            setError(result.error);
            setStatus('error');
          }
        })
        .catch((err: unknown) => {
          // A superseded/cancelled job is expected during rapid changes; ignore.
          if (cancelled || err instanceof JobCancelledError) return;
          setOutput('');
          setError({
            message:
              err instanceof Error && err.message
                ? err.message
                : 'The conversion failed unexpectedly.',
          });
          setStatus('error');
        });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sourceText, format, direction, runConvert]);

  const targetLabel = FORMATS.find((f) => f.id === format)!.label;
  const sourceLabel = direction === 'fromJson' ? 'JSON' : targetLabel;
  const outputLabel = direction === 'fromJson' ? targetLabel : 'JSON';

  const onCopy = async () => {
    if (output === '') return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section aria-label="Converter panel" data-tool-panel="converter" class="flex flex-col gap-md">
      {/* ── Controls ─────────────────────────────────────────────────── */}
      <div class="flex flex-wrap items-center gap-md">
        <div role="group" aria-label="Target format" class="flex items-center gap-xxs">
          {FORMATS.map((f) => {
            const selected = f.id === format;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={selected}
                class={
                  'rounded-xs px-sm py-xxs text-button-md ring-1 ring-inset ' +
                  (selected
                    ? 'bg-primary text-on-primary ring-primary'
                    : 'text-body ring-hairline hover:bg-canvas-soft')
                }
                onClick={() => setFormat(f.id)}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div role="group" aria-label="Direction" class="flex items-center gap-xxs">
          <button
            type="button"
            aria-pressed={direction === 'fromJson'}
            class={
              'rounded-xs px-sm py-xxs text-button-md ring-1 ring-inset ' +
              (direction === 'fromJson'
                ? 'bg-primary text-on-primary ring-primary'
                : 'text-body ring-hairline hover:bg-canvas-soft')
            }
            onClick={() => setDirection('fromJson')}
          >
            {`JSON → ${targetLabel}`}
          </button>
          <button
            type="button"
            aria-pressed={direction === 'toJson'}
            class={
              'rounded-xs px-sm py-xxs text-button-md ring-1 ring-inset ' +
              (direction === 'toJson'
                ? 'bg-primary text-on-primary ring-primary'
                : 'text-body ring-hairline hover:bg-canvas-soft')
            }
            onClick={() => setDirection('toJson')}
          >
            {`${targetLabel} → JSON`}
          </button>
        </div>

        <span class="ml-auto text-caption text-mute" aria-live="polite">
          {status === 'converting' ? 'Converting…' : ''}
        </span>
      </div>

      {/* ── Source / output ──────────────────────────────────────────── */}
      <div class="grid grid-cols-1 gap-md md:grid-cols-2">
        {/* Source */}
        <div class="flex min-h-0 flex-col gap-xs">
          <label class="text-body-sm-strong text-ink" for="convert-source">
            {`Source · ${sourceLabel}`}
          </label>
          {direction === 'fromJson' ? (
            // The JSON source is the shared document, shown read-only.
            <textarea
              id="convert-source"
              readOnly
              aria-label={`Source ${sourceLabel} (shared document)`}
              class="min-h-[280px] w-full resize-y rounded-sm border border-divider bg-canvas-soft p-sm font-mono text-code text-body"
              value={doc.text}
              placeholder="The shared JSON document is empty."
            />
          ) : (
            <textarea
              id="convert-source"
              aria-label={`Source ${sourceLabel}`}
              class="min-h-[280px] w-full resize-y rounded-sm border border-hairline bg-canvas p-sm font-mono text-code text-ink"
              value={formatSource}
              onInput={(e) => setFormatSource((e.target as HTMLTextAreaElement).value)}
              placeholder={`Paste ${sourceLabel} to convert to JSON…`}
            />
          )}
        </div>

        {/* Output */}
        <div class="flex min-h-0 flex-col gap-xs">
          <div class="flex items-center gap-xs">
            <label class="text-body-sm-strong text-ink" for="convert-output">
              {`Output · ${outputLabel}`}
            </label>
            <div class="ml-auto flex items-center gap-xs">
              {status === 'done' && output !== '' ? (
                <button
                  type="button"
                  class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft"
                  onClick={onCopy}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              ) : null}
              {direction === 'toJson' && status === 'done' && output !== '' ? (
                <button
                  type="button"
                  class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft"
                  onClick={() => setDocumentText(output)}
                >
                  Load into editor
                </button>
              ) : null}
            </div>
          </div>

          {status === 'error' && error ? (
            <div
              role="alert"
              class="min-h-[280px] w-full overflow-auto rounded-sm border border-error bg-error-soft p-sm"
            >
              <p class="text-body-sm-strong text-error-deep">Conversion failed</p>
              <p class="mt-xs text-body-sm text-error-deep">{error.message}</p>
              {error.line !== undefined || error.path !== undefined ? (
                <p class="mt-xs text-caption text-error-deep">
                  {error.line !== undefined ? `Line ${error.line}` : null}
                  {error.line !== undefined && error.path !== undefined ? ' · ' : null}
                  {error.path !== undefined ? `Path ${error.path}` : null}
                </p>
              ) : null}
              <p class="mt-sm text-caption text-mute">The source is unchanged.</p>
            </div>
          ) : (
            <textarea
              id="convert-output"
              readOnly
              aria-label={`Output ${outputLabel}`}
              class="min-h-[280px] w-full resize-y rounded-sm border border-divider bg-canvas-soft p-sm font-mono text-code text-body"
              value={output}
              placeholder={
                sourceText.trim() === ''
                  ? `Provide ${sourceLabel} to see the ${outputLabel} output.`
                  : ''
              }
            />
          )}
        </div>
      </div>
    </section>
  );
}
