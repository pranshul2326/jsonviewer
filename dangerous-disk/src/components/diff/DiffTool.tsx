/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 19.3
//
// DiffTool — the composed Diff Checker tool mounted by the AppShell router.
//
// It brings the four diff/merge surfaces together into a single cohesive tool
// with two modes:
//
//   • "Compare" — the Monaco diff editor (DiffPanel) is the single Left/Right
//     input and visualization (Req 9). Its live text drives the path-keyed
//     semantic difference list (SemanticDiffList, Req 8) and the RFC 6902 patch
//     export (PatchExport, Req 10) shown beneath it.
//   • "Merge"   — the self-contained three-way merge (MergePanel, Req 11).
//
// Per the design (Execution Model and Routing): the Diff Checker keeps its own
// Left/Right buffers but seeds Left from the shared `$document` on entry, so the
// content the user was viewing flows into the comparison (Req 21.5/21.6). The
// shared `$document` store is never mutated here, so returning to a tool that
// operates on the shared document restores it byte-for-byte (Req 21.6). All
// chrome derives from design tokens (Req 22.1).

import { useEffect, useState } from 'preact/hooks';
import { useStore } from '@nanostores/preact';
import {
  $document,
  $diffBuffers,
  restoreDiffBuffersFromStorage,
} from '../../lib/stores/document';
import DiffPanel from './DiffPanel';
import { SemanticDiffList } from './SemanticDiffList';
import { PatchExport } from './PatchExport';
import MergePanel from './MergePanel';

/** The two modes of the Diff Checker tool. */
type DiffMode = 'compare' | 'merge';

/** Shared base classes for the mode-toggle segmented control buttons. */
const TAB_BASE =
  'inline-flex items-center font-sans text-button-md rounded-md px-3 py-1.5 ' +
  'transition-colors cursor-pointer select-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50';
const TAB_ACTIVE = 'bg-canvas text-ink shadow-level-1';
const TAB_INACTIVE = 'text-body hover:text-ink';

/**
 * The composed Diff Checker. Owns the Left/Right buffers (seeded from the shared
 * document on entry) and switches between the compare and merge modes.
 */
export default function DiffTool() {
  // Initialize the Diff buffers *after* hydration (in a mount effect), never
  // during render. Restoring persisted buffers — which include the active mode
  // (compare/merge) — synchronously at module load would diverge from the
  // server-rendered HTML (built with the default compare mode) and cause a
  // hydration mismatch that visibly distorted the Merge panel on first load.
  // Running it here ensures the first client render matches the SSR markup, and
  // the store then settles to the restored/seeded values cleanly.
  useEffect(() => {
    // Restore any buffers persisted across page loads (sets `seeded` when found).
    restoreDiffBuffersFromStorage();
    // Otherwise seed Left from the shared document the first time the Diff tool
    // is opened in this session, so the content the user was viewing flows into
    // the comparison (Req 21.5/21.6). The shared `$document` is never mutated.
    const buffers = $diffBuffers.get();
    if (!buffers.seeded) {
      $diffBuffers.set({ ...buffers, left: $document.get().text, seeded: true });
    }
  }, []);

  const { left: leftText, right: rightText, mode } = useStore($diffBuffers);

  // Total structural differences, surfaced by the semantic diff list so it can
  // be shown in the always-visible toolbar (not just in the list below).
  const [diffCount, setDiffCount] = useState<number | null>(null);

  const setMode = (next: DiffMode) => $diffBuffers.setKey('mode', next);
  const setLeftText = (text: string) => $diffBuffers.setKey('left', text);
  const setRightText = (text: string) => $diffBuffers.setKey('right', text);

  return (
    <section
      aria-label="Diff Checker panel"
      data-tool-panel="diff"
      class="flex flex-col gap-md p-md"
    >
      {/* Mode toggle: Compare (diff + semantic list + patch) vs Merge. */}
      <div
        class="inline-flex items-center gap-1 self-start rounded-lg bg-canvas-soft-2 p-1"
        role="group"
        aria-label="Diff Checker mode"
      >
        <button
          type="button"
          class={`${TAB_BASE} ${mode === 'compare' ? TAB_ACTIVE : TAB_INACTIVE}`}
          aria-pressed={mode === 'compare'}
          data-mode="compare"
          onClick={() => setMode('compare')}
        >
          Compare
        </button>
        <button
          type="button"
          class={`${TAB_BASE} ${mode === 'merge' ? TAB_ACTIVE : TAB_INACTIVE}`}
          aria-pressed={mode === 'merge'}
          data-mode="merge"
          onClick={() => setMode('merge')}
        >
          Merge
        </button>
      </div>

      {mode === 'compare' ? (
        <div class="flex flex-col gap-md" data-mode-panel="compare">
          {/* Monaco diff editor: the single Left/Right input + visualization.
              Given a tall, viewport-based height so the two JSON panes are large
              (like the Viewer); the semantic list and patch export flow below it
              and the page scrolls. */}
          <div class="h-[75vh] shrink-0 overflow-hidden rounded-lg border border-hairline">
            <DiffPanel
              initialLeft={leftText}
              initialRight={rightText}
              onLeftChange={setLeftText}
              onRightChange={setRightText}
              differenceCount={diffCount}
            />
          </div>

          {/* Path-keyed semantic difference list (Req 8). */}
          <SemanticDiffList leftText={leftText} rightText={rightText} onCount={setDiffCount} />

          {/* RFC 6902 JSON Patch export (Req 10). */}
          <PatchExport left={leftText} right={rightText} />
        </div>
      ) : (
        <div class="h-[calc(100dvh-14rem)] overflow-hidden" data-mode-panel="merge">
          <MergePanel />
        </div>
      )}
    </section>
  );
}
