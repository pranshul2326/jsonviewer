// Feature: json-viewer-free — Task 14.1
//
// Pure, framework-free decision logic backing {@link DiffPanel}.
//
// Keeping the "what should the Diff Checker show?" decision out of the Preact
// component (and away from Monaco) makes it directly unit-testable in jsdom
// without booting the editor — mirroring how `editor-markers.ts` sits beside
// `EditorPane.tsx`.
//
// The function answers three questions for a given Left/Right text pair:
//   • Did either document fail to parse, and which one? (Req 9.7)
//   • Are both documents valid? (gates whether the diff view is refreshed)
//   • When both are valid, are they free of any structural difference, so the
//     "no differences found" message should be shown? (Req 9.6)
//
// Crucially this function never *applies* anything — the component decides,
// from `bothValid`, whether to update the Monaco models. When a document fails
// to parse the component keeps the previously displayed diff (Req 9.7); this
// module simply reports the failure.

import { parseJson } from '../../lib/json-core/parse';
import { semanticDiff } from '../../lib/json-core/diff';

/** Which of the two compared documents an error refers to. */
export type DiffDocSide = 'left' | 'right';

/** A per-document parse failure, identifying the offending side (Req 9.7). */
export interface DiffDocError {
  /** Which document failed to parse. */
  side: DiffDocSide;
  /** 1-based line of the first syntax error. */
  line: number;
  /** 1-based column of the first syntax error. */
  column: number;
  /**
   * A user-facing message that names the document and describes the error,
   * e.g. `"Left document could not be parsed: …"`.
   */
  message: string;
}

/**
 * The outcome of evaluating a Left/Right text pair.
 *
 *   - `errors` — one entry per document that failed to parse, in reading order
 *     (left before right). Empty when both documents are valid.
 *   - `bothValid` — true only when *both* documents parse. The component
 *     refreshes the diff view (and recomputes `noDifferences`) only in this
 *     case; otherwise it retains the prior result (Req 9.7).
 *   - `noDifferences` — when `bothValid`, whether the two documents are
 *     structurally equivalent so the "no differences found" message applies
 *     (Req 9.6). `null` when validity is undetermined (a document failed).
 */
export interface DiffComputation {
  errors: DiffDocError[];
  bothValid: boolean;
  noDifferences: boolean | null;
}

/** Human-readable name for a document side. */
function sideLabel(side: DiffDocSide): string {
  return side === 'left' ? 'Left' : 'Right';
}

/**
 * Evaluate a Left/Right document text pair for the Diff Checker.
 *
 * Both documents are parsed with the shared, authoritative `parseJson`. A
 * document that fails to parse contributes a {@link DiffDocError} naming its
 * side (Req 9.7). When both documents parse, structural equivalence is decided
 * by `semanticDiff` (so key-reordering and whitespace-only differences report
 * no differences, Req 8.2/8.3) to drive the "no differences found" message
 * (Req 9.6). Empty/whitespace-only input is valid; two empty documents are
 * considered identical, and an empty document paired with a non-empty one
 * differs.
 *
 * @param leftText  Raw text of the Left document.
 * @param rightText Raw text of the Right document.
 * @returns The {@link DiffComputation} describing what the panel should show.
 */
export function computeDiffViewState(
  leftText: string,
  rightText: string,
): DiffComputation {
  const left = parseJson(leftText);
  const right = parseJson(rightText);

  const errors: DiffDocError[] = [];
  if (!left.ok) {
    errors.push({
      side: 'left',
      line: left.error.line,
      column: left.error.column,
      message: `${sideLabel('left')} document could not be parsed: ${left.error.message}`,
    });
  }
  if (!right.ok) {
    errors.push({
      side: 'right',
      line: right.error.line,
      column: right.error.column,
      message: `${sideLabel('right')} document could not be parsed: ${right.error.message}`,
    });
  }

  // A parse failure leaves validity (and therefore the diff outcome)
  // undetermined; the component retains whatever it previously displayed.
  if (errors.length > 0) {
    return { errors, bothValid: false, noDifferences: null };
  }

  // Both documents are valid. Decide structural equivalence on the model.
  // `parseJson` reports empty/whitespace-only input as a valid-empty result
  // with `model: null`.
  const leftModel = left.ok && !left.empty ? left.model : null;
  const rightModel = right.ok && !right.empty ? right.model : null;

  let noDifferences: boolean;
  if (leftModel !== null && rightModel !== null) {
    noDifferences = semanticDiff(leftModel, rightModel).length === 0;
  } else {
    // At least one side is empty: identical only when both are empty.
    noDifferences = leftModel === null && rightModel === null;
  }

  return { errors: [], bothValid: true, noDifferences };
}
