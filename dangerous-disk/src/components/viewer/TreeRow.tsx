/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 13.5
//
// TreeRow: the full per-row UI for the Viewer's collapsible tree. It is slotted
// into {@link TreePanel} via its `renderRow` prop and renders, for one
// {@link FlatRow}:
//
//   - depth indentation and an expand/collapse caret for expandable containers
//     (empty containers show no caret — handled by TreePanel via `hasChildren`);
//   - the {@link TypeBadge} for the node's JSON type (Req 3);
//   - the key label (object key, array index, or `$` at the root);
//   - the value: a child count for objects/arrays (Req 1.6) or a rich-media
//     rendering of the scalar (Req 12) via {@link RichMedia};
//   - an action cluster for editing and path copy.
//
// Editing is delegated entirely to the pure helpers in
// `lib/json-core/node-edit.ts`, so this component owns only presentation, draft
// input state, and error display. On a successful edit it calls `onCommit` with
// the new model; the caller serializes that model back into the shared
// `$document` editor text (Req 2.8). On a rejected edit it shows the error
// message and leaves the document unchanged (Req 2.5, 2.6, 2.7).
//
// Path copy computes the dot- or bracket-notation path with `dotPath` /
// `bracketPath` and writes it to the clipboard; a confirmation indicator is
// shown immediately (well within 500 ms) and held for at least 2 s (Req 4.3),
// and a copy failure shows an error indication while leaving the document
// unchanged (Req 4.4). The clipboard writer is injectable for testing.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { FlatRow, RowHandlers } from './TreePanel';
import { TypeBadge } from './TypeBadge';
import { RichMedia } from './RichMedia';
import { dotPath } from '../../lib/json-core/path';
import {
  deleteNode,
  renameKey,
  editScalarText,
  isScalarType,
} from '../../lib/json-core/node-edit';
import type { JsonNode } from '../../lib/json-core/types';

/** How long the path-copy confirmation/error indicator stays visible (Req 4.3: >= 2 s). */
export const COPY_INDICATOR_MS = 2000;

/** The transient state of the path-copy indicator. */
type CopyState = 'idle' | 'copied' | 'error';

/** Which inline editor (if any) is currently open. */
type EditMode = 'none' | 'scalar' | 'rename';

/** Props for {@link TreeRow}. */
export interface TreeRowProps {
  /** The flattened row to render (node + depth + expansion flags). */
  row: FlatRow;
  /** Row handlers from {@link TreePanel} (expand/collapse toggle). */
  handlers: RowHandlers;
  /** The full document model — required to compute paths and apply edits. */
  root: JsonNode;
  /**
   * Called with the new model after a successful edit. The caller is
   * responsible for serializing it back into the shared editor text (Req 2.8).
   */
  onCommit: (model: JsonNode) => void;
  /** Whether rich-media inference is enabled for scalar values (Req 12.6). */
  richMediaEnabled?: boolean;
  /**
   * Clipboard writer. Defaults to `navigator.clipboard.writeText`. Injectable so
   * tests can simulate success and failure (Req 4.3, 4.4).
   */
  writeClipboard?: (text: string) => Promise<void>;
  /**
   * Reports an edit-rejection message (duplicate key, invalid scalar, …) to the
   * parent so it can surface it in the tree toolbar; called with `null` when the
   * error is cleared. When omitted, edit errors are silently dropped.
   */
  onError?: (message: string | null) => void;
  /**
   * The id of the row currently being edited anywhere in the tree. A row only
   * renders its inline editor when this matches its own id, so opening one
   * editor closes any other (single active editor at a time).
   */
  activeEditId?: string | null;
  /** Claim (with this row's id) or release (`null`) the single active editor. */
  onActiveEditChange?: (id: string | null) => void;
}

/** Default clipboard writer backed by the async Clipboard API. */
function defaultWriteClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('Clipboard API is unavailable'));
}

/** The label shown for a row's key: the property name, array index, or `$` at root. */
function keyLabel(node: JsonNode): string {
  if (node.key === null) return '$';
  return String(node.key);
}

/** A scalar node's display value as a string (containers are handled separately). */
function scalarText(node: JsonNode): string {
  switch (node.type) {
    case 'string':
      return node.stringValue ?? '';
    case 'number':
      return node.numberValue ?? '';
    case 'boolean':
      return node.boolValue ? 'true' : 'false';
    case 'null':
      return 'null';
    default:
      return '';
  }
}

/**
 * The raw JSON-scalar text a user starts editing from, so that submitting an
 * unchanged value is a valid round-trip: strings are quoted, every other scalar
 * is its literal text.
 */
function scalarEditSeed(node: JsonNode): string {
  if (node.type === 'string') return JSON.stringify(node.stringValue ?? '');
  return scalarText(node);
}

/** The direct-child count for a container node (Req 1.6). */
function childCount(node: JsonNode): number {
  return node.children?.length ?? 0;
}

/**
 * The full per-row UI: badge, key, value/child-count, inline editors, and the
 * path-copy + edit action cluster.
 */
export function TreeRow({
  row,
  handlers,
  root,
  onCommit,
  richMediaEnabled = true,
  writeClipboard = defaultWriteClipboard,
  onError,
  activeEditId,
  onActiveEditChange,
}: TreeRowProps) {
  const { node, depth, expanded, hasChildren } = row;

  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [editMode, setEditMode] = useState<EditMode>('none');
  // Edit-rejection messages are surfaced by the parent (in the tree toolbar),
  // not as a per-row box; `setError` simply forwards to the `onError` callback.
  const setError = (message: string | null) => onError?.(message);

  // Only the row whose id matches `activeEditId` shows its editor. When the
  // active editor is controlled by the parent (prop provided), a row edits ONLY
  // when it is the active id — so once the active editor is released (null), no
  // row falls back to a stale local `editMode`. When uncontrolled (prop
  // omitted, e.g. in unit tests) the local `editMode` drives the editor.
  const controlled = activeEditId !== undefined;
  const effectiveMode: EditMode = controlled
    ? activeEditId === node.id
      ? editMode
      : 'none'
    : editMode;

  // Draft inputs for the inline editors.
  const [scalarDraft, setScalarDraft] = useState('');
  const [renameDraft, setRenameDraft] = useState('');

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tear down the copy-indicator timer on unmount.
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  // Capability flags drive which actions/editors are offered.
  const isRoot = node.key === null;
  const isObject = node.type === 'object';
  const isContainer = node.type === 'object' || node.type === 'array';
  const isScalar = isScalarType(node.type);
  const isObjectMember = typeof node.key === 'string';

  const indent = depth * 16;

  /** Show the copy indicator immediately and hold it for at least 2 s (Req 4.3). */
  function flashCopyState(state: CopyState) {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    setCopyState(state);
    copyTimer.current = setTimeout(() => setCopyState('idle'), COPY_INDICATOR_MS);
  }

  /** Copy the dot-notation path of this node to the clipboard. */
  async function copyPath() {
    let path: string;
    try {
      path = dotPath(root, node.id);
    } catch {
      // The node is no longer present in the model; treat as a copy failure.
      flashCopyState('error');
      return;
    }
    try {
      await writeClipboard(path);
      flashCopyState('copied'); // visible within 500 ms (synchronous on resolve)
    } catch {
      flashCopyState('error'); // Req 4.4: document is untouched by a copy attempt
    }
  }

  /** Open a specific inline editor, seeding its draft and clearing any error. */
  function openEditor(mode: Exclude<EditMode, 'none'>) {
    setError(null);
    if (mode === 'scalar') setScalarDraft(scalarEditSeed(node));
    if (mode === 'rename') setRenameDraft(isObjectMember ? String(node.key) : '');
    setEditMode(mode);
    // Claim the single active editor so any other open editor closes.
    onActiveEditChange?.(node.id);
  }

  /** Close this row's editor and release the single active editor. */
  function closeEditor() {
    setEditMode('none');
    setError(null);
    onActiveEditChange?.(null);
  }

  /** Close any open inline editor without committing. */
  function cancelEdit() {
    closeEditor();
  }

  function commitScalar() {
    // Ignore stray commits (e.g. a blur fired after the editor already closed).
    if (effectiveMode !== 'scalar') return;
    const result = editScalarText(root, node.id, scalarDraft);
    if (result.ok) {
      onCommit(result.model);
      closeEditor();
    } else {
      // Req 2.7: reject, leave value unchanged, show the error.
      setError(result.error.message);
    }
  }

  function commitRename() {
    // Ignore stray commits (e.g. a blur fired after the editor already closed).
    if (effectiveMode !== 'rename') return;
    const result = renameKey(root, node.id, renameDraft);
    if (result.ok) {
      onCommit(result.model);
      closeEditor();
    } else {
      // Req 2.5: reject, leave the object unchanged, identify the conflicting key.
      setError(result.error.message);
    }
  }

  function handleDelete() {
    const result = deleteNode(root, node.id);
    if (result.ok) {
      onCommit(result.model);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }

  /** Commit on Enter, cancel on Escape, for the single-field editors. */
  function onEditorKeyDown(commit: () => void) {
    return (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      }
    };
  }

  return (
    <div class="relative h-full">
      <div
        class="flex h-full items-center gap-xs px-sm font-mono text-code hover:bg-canvas-soft"
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        {/* Expand/collapse caret (only for non-empty containers). */}
        {hasChildren ? (
          <button
            type="button"
            class="inline-flex h-4 w-4 shrink-0 items-center justify-center text-mute hover:text-ink"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
            onClick={() => handlers.toggle(node.id)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span class="inline-block h-4 w-4 shrink-0" aria-hidden="true" />
        )}

        {/* Type badge (Req 3). */}
        <TypeBadge type={node.type} />

        {/* Key label. */}
        {effectiveMode === 'rename' ? (
          <input
            class="w-32 rounded-xs px-xs py-0 text-code ring-1 ring-inset ring-link focus:outline-none"
            aria-label="Rename key"
            value={renameDraft}
            autoFocus
            onInput={(e) => setRenameDraft((e.target as HTMLInputElement).value)}
            onKeyDown={onEditorKeyDown(commitRename)}
            onBlur={commitRename}
          />
        ) : isObjectMember ? (
          <span
            class="shrink-0 cursor-text text-ink"
            title="Double-click to rename"
            onDblClick={() => openEditor('rename')}
          >
            {keyLabel(node)}
          </span>
        ) : (
          <span class="shrink-0 text-ink">{keyLabel(node)}</span>
        )}
        <span class="text-mute">:</span>

        {/* Value: child count for containers (Req 1.6), rich-media for scalars (Req 12). */}
        {isContainer ? (
          <span class="text-mute">
            {node.type === 'array' ? '[' : '{'}
            <span class="px-xxs text-caption text-body" data-testid="child-count">
              {childCount(node)}
            </span>
            {node.type === 'array' ? ']' : '}'}
          </span>
        ) : effectiveMode === 'scalar' ? (
          <input
            class="min-w-32 flex-1 rounded-xs px-xs py-0 text-code ring-1 ring-inset ring-link focus:outline-none"
            aria-label="Edit value"
            value={scalarDraft}
            autoFocus
            onInput={(e) => setScalarDraft((e.target as HTMLInputElement).value)}
            onKeyDown={onEditorKeyDown(commitScalar)}
            onBlur={commitScalar}
          />
        ) : (
          <span
            class="min-w-0 cursor-text truncate"
            title="Double-click to edit"
            onDblClick={() => openEditor('scalar')}
          >
            <RichMedia value={scalarText(node)} enabled={richMediaEnabled} />
          </span>
        )}

        {/* Action cluster. */}
        <span class="ml-auto flex shrink-0 items-center gap-xxs pl-xs">
          {/* Path copy (Req 4.1, 4.2). */}
          <button
            type="button"
            class="rounded-xs px-xs text-caption text-mute ring-1 ring-inset ring-hairline hover:text-ink"
            title="Copy dot-notation path"
            aria-label="Copy dot-notation path"
            onClick={() => copyPath()}
          >
            .path
          </button>

          {/* Edit actions. */}
          {isScalar && effectiveMode === 'none' ? (
            <button
              type="button"
              class="rounded-xs px-xs text-caption text-mute hover:text-ink"
              title="Edit value"
              aria-label="Edit value"
              onClick={() => openEditor('scalar')}
            >
              edit
            </button>
          ) : null}
          {isObjectMember && effectiveMode === 'none' ? (
            <button
              type="button"
              class="rounded-xs px-xs text-caption text-mute hover:text-ink"
              title="Rename key"
              aria-label="Rename key"
              onClick={() => openEditor('rename')}
            >
              rename
            </button>
          ) : null}
          {!isRoot && effectiveMode === 'none' ? (
            <button
              type="button"
              class="rounded-xs px-xs text-caption text-error hover:text-error-deep"
              title="Delete node"
              aria-label="Delete node"
              onClick={handleDelete}
            >
              delete
            </button>
          ) : null}

          {/* Copy confirmation / failure indicator (Req 4.3, 4.4). */}
          {copyState === 'copied' ? (
            <span class="text-caption text-badge-bool" role="status" data-testid="copy-confirmation">
              copied
            </span>
          ) : null}
          {copyState === 'error' ? (
            <span class="text-caption text-error" role="status" data-testid="copy-error">
              copy failed
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export default TreeRow;
