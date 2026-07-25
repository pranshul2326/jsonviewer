/** @jsxImportSource preact */
// Feature: json-viewer-free — Text Compare
//
// TextCompareTool — the composed Text Compare tool mounted by the AppShell
// router. It is the plain-text sibling of the JSON DiffTool: a single Left/Right
// comparison surface for arbitrary text, with none of the JSON-specific
// machinery (no semantic difference list, no RFC 6902 patch export, no merge).
//
// Like DiffTool, it keeps its own Left/Right buffers in a shared store so both
// pasted documents survive tool switches (Req 21.5/21.6), seeds Left from the
// shared `$document` on first entry so the content the user was viewing flows
// into the comparison, and never mutates `$document`. Multiple comparisons are
// held at once and surfaced as tabs in the panel toolbar. All chrome derives
// from design tokens (Req 22.1).

import { useEffect, useState } from 'preact/hooks';
import { useStore } from '@nanostores/preact';
import {
  $document,
  $textCompareBuffers,
  restoreTextCompareBuffersFromStorage,
  seedTextLeftIfNeeded,
  addTextComparison,
  closeTextComparison,
  setActiveTextComparison,
  updateActiveTextComparison,
  clearActiveTextComparison,
} from '../../lib/stores/document';
import TextComparePanel from './TextComparePanel';

/**
 * The composed Text Compare tool. Owns the Left/Right buffers (seeded from the
 * shared document on entry) and renders the plain-text diff editor.
 */
export default function TextCompareTool() {
  // Whether the persisted buffers have been restored yet. The Monaco editor is
  // not mounted until this is true, so it builds its models from the final
  // restored text rather than the empty pre-restore buffers (which on a fast,
  // cached load could otherwise win the race and clear the content).
  const [buffersRestored, setBuffersRestored] = useState(false);

  // Initialize the buffers *after* hydration (in a mount effect), never during
  // render, mirroring DiffTool: restoring persisted buffers synchronously at
  // module load would diverge from the server-rendered HTML and risk a
  // hydration mismatch.
  useEffect(() => {
    // Restore any buffers persisted across page loads (sets `seeded` when found).
    restoreTextCompareBuffersFromStorage();
    // Otherwise seed Left from the shared document the first time the tool is
    // opened this session, so the content the user was viewing flows into the
    // comparison. The shared `$document` is never mutated.
    seedTextLeftIfNeeded($document.get().text);
    // Mount the editor only now, so it is created once with the final text.
    setBuffersRestored(true);
  }, []);

  // Contain horizontal overscroll while the tool is mounted so a two-finger
  // swipe inside the Monaco diff panes never triggers the browser's back/forward
  // navigation gesture. Scoped to <html> (not global) so ordinary swipe-back
  // keeps working elsewhere; removed on unmount. (Same fix as DiffTool.)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const CLASS = 'jvf-contain-overscroll-x';
    document.documentElement.classList.add(CLASS);
    return () => document.documentElement.classList.remove(CLASS);
  }, []);

  const { comparisons, activeId } = useStore($textCompareBuffers);
  const active = comparisons.find((c) => c.id === activeId) ?? comparisons[0];
  const leftText = active.left;
  const rightText = active.right;
  const leftName = active.leftName;
  const rightName = active.rightName;

  const setLeftText = (text: string) => updateActiveTextComparison({ left: text });
  const setRightText = (text: string) => updateActiveTextComparison({ right: text });
  const setLeftName = (name: string) => updateActiveTextComparison({ leftName: name });
  const setRightName = (name: string) => updateActiveTextComparison({ rightName: name });
  // Clear the active comparison's texts and labels (its tab stays open). The
  // shared buffers and their localStorage mirror are wiped together.
  const clearAll = () => clearActiveTextComparison();

  return (
    <section
      aria-label="Text Compare panel"
      data-tool-panel="text"
      class="flex min-h-0 flex-1 flex-col gap-md p-md"
    >
      {/* Monaco diff editor over plain-text models: the single Left/Right input
          and visualization. Fills the remaining height of the tool card, exactly
          like the Converter tab's content area. */}
      <div class="min-h-0 flex-1 overflow-hidden rounded-lg border border-hairline">
        {buffersRestored && (
          <TextComparePanel
            initialLeft={leftText}
            initialRight={rightText}
            onLeftChange={setLeftText}
            onRightChange={setRightText}
            leftName={leftName}
            rightName={rightName}
            onLeftNameChange={setLeftName}
            onRightNameChange={setRightName}
            onClear={clearAll}
            comparisons={comparisons.map((c) => ({ id: c.id, name: c.name }))}
            activeId={activeId}
            onSelectComparison={setActiveTextComparison}
            onAddComparison={addTextComparison}
            onCloseComparison={closeTextComparison}
          />
        )}
      </div>
    </section>
  );
}
