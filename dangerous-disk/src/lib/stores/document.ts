// Feature: json-viewer-free
//
// Shared application state, framework-agnostic (Req 21.5, 21.6).
//
// These nanostores are the single source of truth shared across the four tool
// panels. The `@nanostores/preact` bindings are used inside components; this
// module stays free of any UI framework so the same stores can be read from
// workers, tests, or plain modules.
//
//   $document   — the one shared editor document (raw text + parsed model).
//                 Per Req 21.5/21.6 the document text must be preserved
//                 byte-for-byte across tool switches, so this store is the
//                 single source of truth shared by the Viewer/Grid/Converter
//                 tools.
//   $activeTool — which of the four navigation tools is currently active.
//   $settings   — UI/user settings (indentation style, rich-media on/off).

import { atom, map } from 'nanostores';
import { parseJson, type ParseResult } from '../json-core/parse';
import type { IndentStyle } from '../json-core/serialize';

// ---------------------------------------------------------------------------
// $document — shared editor document (text + parsed model)
// ---------------------------------------------------------------------------

/**
 * The shared editor document: the raw text exactly as the user entered it
 * (preserved byte-for-byte, Req 21.5/21.6) together with the result of parsing
 * that text into the in-memory model.
 */
export interface DocumentState {
  /** Raw editor text, stored verbatim. */
  text: string;
  /** Result of parsing {@link text}: a model, the valid-empty state, or an error. */
  parsed: ParseResult;
}

/** The empty document: empty text parses to the valid-empty state. */
const EMPTY_DOCUMENT: DocumentState = {
  text: '',
  parsed: parseJson(''),
};

/**
 * The single shared editor document. Holds the raw text and the parsed model
 * (and its validity). All tools read and write this one store, so the document
 * survives tool switches without re-parsing (Req 21.5, 21.6).
 */
export const $document = atom<DocumentState>(EMPTY_DOCUMENT);

/**
 * Set the editor text and recompute the parsed model. The text is stored
 * verbatim (byte-for-byte) and {@link parseJson} derives the model/validity.
 *
 * This parses synchronously on the main thread, so it is the path used for
 * small documents (< 5 MB). Large_Documents are parsed off the main thread and
 * the result is published via {@link setDocumentState} instead (Req 17.1).
 */
export function setDocumentText(text: string): void {
  $document.set({ text, parsed: parseJson(text) });
}

/**
 * Publish a document whose text was already parsed elsewhere (e.g. in a Web
 * Worker for a Large_Document, Req 17.1/17.4). The text is stored verbatim and
 * the provided {@link ParseResult} is used as-is, so no second parse runs on the
 * main thread.
 */
export function setDocumentState(text: string, parsed: ParseResult): void {
  $document.set({ text, parsed });
}

// ---------------------------------------------------------------------------
// $workerProgress — long-running worker activity (Req 17.3, 17.5)
// ---------------------------------------------------------------------------

/**
 * The state of an in-flight (or just-failed) long-running worker operation,
 * surfaced to the StatusBar so the user sees a progress indicator while a
 * Large_Document is processed (Req 17.3) and a reason when an operation fails
 * (Req 17.5).
 *
 *   - `{ status: 'running', label, progress }` — the operation is in flight;
 *     `progress` is a completion fraction in [0, 1], updated ≥1/sec.
 *   - `{ status: 'error', label, message }` — the operation failed; `message`
 *     is the human-readable reason. The prior view is retained by the tool; this
 *     only carries the reason to display.
 */
export type WorkerActivity =
  | { status: 'running'; label: string; progress: number }
  | { status: 'error'; label: string; message: string };

/**
 * Shared long-running worker activity. `null` when no operation is in flight
 * and none has recently failed. Tools set it while dispatching to a worker and
 * clear it on completion; the StatusBar renders whatever it holds (Req 17.3).
 */
export const $workerProgress = atom<WorkerActivity | null>(null);

/** Set (or clear, with `null`) the shared worker activity. */
export function setWorkerActivity(activity: WorkerActivity | null): void {
  $workerProgress.set(activity);
}

// ---------------------------------------------------------------------------
// $activeTool — which tool is active
// ---------------------------------------------------------------------------

/** The four primary tools, matching the navigation entries (Req 21.1). */
export type Tool = 'viewer' | 'diff' | 'grid' | 'converter';

/** The currently active tool. Defaults to the Viewer. */
export const $activeTool = atom<Tool>('viewer');

/** Set the active tool. */
export function setActiveTool(tool: Tool): void {
  $activeTool.set(tool);
}

// ---------------------------------------------------------------------------
// $settings — UI / user settings
// ---------------------------------------------------------------------------

/** UI/user settings shared across tools. */
export interface Settings {
  /** Indentation style used by the Formatter (2-space, 4-space, or tab). */
  indentStyle: IndentStyle;
  /** Whether rich-media inference (previews, swatches, links) is enabled (Req 12.6). */
  richMediaEnabled: boolean;
}

/** Default settings: 2-space indentation with rich media enabled. */
const DEFAULT_SETTINGS: Settings = {
  indentStyle: { kind: 'space', size: 2 },
  richMediaEnabled: true,
};

/** Shared UI/user settings. */
export const $settings = map<Settings>({ ...DEFAULT_SETTINGS });

/** Set the indentation style used when formatting (Req 5.1–5.3). */
export function setIndentStyle(indentStyle: IndentStyle): void {
  $settings.setKey('indentStyle', indentStyle);
}

/** Enable or disable rich-media inference (Req 12.6). */
export function setRichMediaEnabled(enabled: boolean): void {
  $settings.setKey('richMediaEnabled', enabled);
}
