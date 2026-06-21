/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 12.2
//
// StatusBar: a presentational Preact island that surfaces the live document
// status beneath the editor. It reads the shared `$document` store and renders:
//
//   • A validity indicator (Req 6.2, 6.3):
//       - VALID  — shown whenever the document parses (`parsed.ok === true`),
//         which INCLUDES empty / whitespace-only input (the valid-empty state,
//         Req 6.3). Uses the `success` token and a distinct check glyph.
//       - ERROR  — shown when `parsed.ok === false`, carrying the validator's
//         error message together with its 1-based line:column (Req 6.2, 6.4).
//         Uses the `error` token and a distinct cross glyph.
//     The valid and error indicators are visually distinct in both color and
//     icon so they can never be confused (Req 6.2).
//
//   • The document size — character count plus a human-readable UTF-8 byte size
//     (B / KB / MB) of `$document.text`.
//
//   • A worker progress indicator (Req 17.3): when a long-running operation is
//     in flight, the parent passes a `progress` fraction (0–1) and this bar
//     renders a determinate progress track. Wiring the actual worker progress
//     is Task 19.1; here StatusBar simply renders whatever it is given and
//     shows nothing when `progress` is null/undefined.
//
// All styling derives from design tokens (caption / mono typography, success /
// error / hairline colors) — no hardcoded color or size values (Req 22.1).

import { useStore } from '@nanostores/preact';
import { $document, $workerProgress } from '../../lib/stores/document';
import type { ParseResult } from '../../lib/json-core/parse';

/** Props for {@link StatusBar}. */
export interface StatusBarProps {
  /**
   * Progress of an in-flight long-running worker operation as a fraction in
   * [0, 1] (Req 17.3). When `null` or `undefined`, no prop-driven progress is
   * shown and StatusBar falls back to the shared `$workerProgress` store, which
   * the Viewer's Large_Document parse path drives.
   */
  progress?: number | null;
  /**
   * Optional human-readable label for the in-flight operation (e.g.
   * "Formatting", "Diffing"), shown next to the progress track when present.
   */
  progressLabel?: string;
}

/** Number of bytes in a kilobyte / megabyte for size formatting. */
const KB = 1024;
const MB = KB * 1024;

/**
 * UTF-8 byte length of `text`. Uses `TextEncoder` when available (browser and
 * modern runtimes); falls back to the character count so the bar still renders
 * in environments without it.
 */
function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

/** Format a UTF-8 byte count as a compact B / KB / MB string. */
function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(2)} MB`;
}

/** Format a character count with thousands separators. */
function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/**
 * The validity indicator. Valid (including the empty/whitespace valid-empty
 * state) renders the success-token check; an error renders the error-token
 * cross plus the message and 1-based line:column (Req 6.2, 6.3, 6.4).
 */
function ValidityIndicator({ parsed }: { parsed: ParseResult }) {
  if (parsed.ok) {
    return (
      <span
        class="inline-flex items-center gap-1.5 font-sans text-caption text-success"
        data-status="valid"
        role="status"
        aria-label="Valid JSON"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
        <span>Valid</span>
      </span>
    );
  }

  const { message, line, column } = parsed.error;
  return (
    <span
      class="inline-flex items-center gap-1.5 font-sans text-caption text-error"
      data-status="error"
      role="status"
      aria-label={`Invalid JSON: ${message}`}
      title={message}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.25" />
        <line x1="8" y1="4.75" x2="8" y2="8.75" />
        <line x1="8" y1="11" x2="8" y2="11.25" />
      </svg>
      <span class="max-w-[40ch] truncate">{message}</span>
      <span class="font-mono text-caption-mono text-error-deep">
        {line}:{column}
      </span>
    </span>
  );
}

/**
 * The determinate worker progress indicator (Req 17.3). Renders a labeled track
 * filled to `fraction` (clamped to [0, 1]). The caller decides when to show it
 * by passing a non-null `progress`.
 */
function ProgressIndicator({
  fraction,
  label,
}: {
  fraction: number;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const pct = Math.round(clamped * 100);

  return (
    <div
      class="inline-flex items-center gap-2"
      data-progress="true"
      role="status"
      aria-label={`${label ?? 'Working'}: ${pct}%`}
    >
      {label && (
        <span class="font-sans text-caption text-body">{label}</span>
      )}
      <div
        class="h-1.5 w-24 overflow-hidden rounded-full bg-canvas-soft-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          class="h-full rounded-full bg-success transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span class="font-mono text-caption-mono text-mute tabular-nums">
        {pct}%
      </span>
    </div>
  );
}

/**
 * A worker failure reason (Req 17.5). Rendered when a long-running operation
 * fails; the tool retains the prior view while this carries the reason.
 */
function WorkerError({ label, message }: { label: string; message: string }) {
  return (
    <span
      class="inline-flex items-center gap-1.5 font-sans text-caption text-error"
      data-worker="error"
      role="alert"
      title={message}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.25" />
        <line x1="8" y1="4.75" x2="8" y2="8.75" />
        <line x1="8" y1="11" x2="8" y2="11.25" />
      </svg>
      <span class="max-w-[40ch] truncate">
        {label} failed: {message}
      </span>
    </span>
  );
}

/**
 * Render the status bar: validity indicator on the left, worker progress (when
 * active) and document size on the right.
 *
 * Worker activity comes from two sources: the explicit `progress` prop (used by
 * a parent that drives a specific operation) and the shared `$workerProgress`
 * store (set by the Viewer's Large_Document parse path, Req 17.3/17.5). The
 * prop takes precedence when provided; otherwise the store's running progress
 * or failure reason is shown.
 */
export function StatusBar({ progress, progressLabel }: StatusBarProps) {
  const doc = useStore($document);
  const activity = useStore($workerProgress);
  const chars = doc.text.length;
  const bytes = byteLength(doc.text);

  const propProgress = progress !== null && progress !== undefined;
  // The store drives the indicator only when no explicit prop progress is given.
  const showStoreRunning =
    !propProgress && activity !== null && activity.status === 'running';
  const showStoreError =
    !propProgress && activity !== null && activity.status === 'error';

  return (
    <div
      class="flex h-8 items-center justify-between gap-2 border-t border-hairline bg-canvas px-2 text-body sm:gap-4 sm:px-4"
      data-component="status-bar"
    >
      {/* Left: validity indicator (Req 6.2, 6.3). */}
      <div class="flex min-w-0 items-center">
        <ValidityIndicator parsed={doc.parsed} />
      </div>

      {/* Right: worker progress / failure reason (Req 17.3, 17.5) + size. */}
      <div class="flex min-w-0 shrink-0 items-center gap-2 sm:gap-4">
        {propProgress && (
          <ProgressIndicator fraction={progress as number} label={progressLabel} />
        )}
        {showStoreRunning && (
          <ProgressIndicator
            fraction={(activity as { progress: number }).progress}
            label={(activity as { label: string }).label}
          />
        )}
        {showStoreError && (
          <WorkerError
            label={(activity as { label: string }).label}
            message={(activity as { message: string }).message}
          />
        )}
        <span
          class="truncate font-mono text-caption-mono text-mute tabular-nums"
          data-size="true"
          title={`${formatCount(chars)} characters · ${formatCount(bytes)} bytes`}
        >
          {formatCount(chars)} chars · {formatBytes(bytes)}
        </span>
      </div>
    </div>
  );
}

export default StatusBar;
