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
// into the comparison, and never mutates `$document`. All chrome derives from
// design tokens (Req 22.1).

import { useEffect, useState } from 'preact/hooks';
import { useStore } from '@nanostores/preact';
import {
  $document,
  $textCompareBuffers,
  restoreTextCompareBuffersFromStorage,
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
    const buffers = $textCompareBuffers.get();
    if (!buffers.seeded) {
      $textCompareBuffers.set({
        ...buffers,
        left: $document.get().text,
        seeded: true,
      });
    }
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

  const {
    left: leftText,
    right: rightText,
    leftName,
    rightName,
  } = useStore($textCompareBuffers);

  const setLeftText = (text: string) => $textCompareBuffers.setKey('left', text);
  const setRightText = (text: string) => $textCompareBuffers.setKey('right', text);
  const setLeftName = (name: string) => $textCompareBuffers.setKey('leftName', name);
  const setRightName = (name: string) => $textCompareBuffers.setKey('rightName', name);
  // Clear both texts and their labels together (shared buffers + localStorage
  // mirror). `seeded` stays true so Left is not re-seeded from $document.
  const clearAll = () =>
    $textCompareBuffers.set({
      left: '',
      right: '',
      leftName: '',
      rightName: '',
      seeded: true,
    });

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
          />
        )}
      </div>
    </section>
  );
}
