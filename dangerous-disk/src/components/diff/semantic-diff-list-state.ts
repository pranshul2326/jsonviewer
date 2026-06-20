// Feature: json-viewer-free — Task 14.2
//
// Pure, framework-free decision logic backing {@link SemanticDiffList}.
//
// Mirroring `diff-view-state.ts`, this keeps the "what should the semantic diff
// list show?" decision out of the Preact component so it is directly
// unit-testable in jsdom without any DOM. The function answers two questions
// for a given Left/Right text pair:
//   • Did either document fail to parse, and which one? When so, the panel must
//     show the validation error state defined in Requirement 6 for the invalid
//     document instead of a list (Req 8.8).
//   • When both documents are valid, what are the path-keyed structural
//     differences (each classified as addition / deletion / modification) that
//     `semanticDiff` reports (Req 8.1)?
//
// Empty / whitespace-only input is valid (it has no model). Two empty documents
// are identical (no differences); an empty document paired with a non-empty one
// is reported as a single root-level addition or deletion, matching the
// add/delete classification rules (Req 8.4, 8.5).

import { parseJson } from '../../lib/json-core/parse';
import { semanticDiff, type Difference } from '../../lib/json-core/diff';
import type { JsonNode } from '../../lib/json-core/types';
import type { DiffDocError, DiffDocSide } from './diff-view-state';

export type { DiffDocError, DiffDocSide } from './diff-view-state';

/**
 * The outcome of evaluating a Left/Right text pair for the semantic diff list.
 *
 *   - `errors` — one entry per document that failed to parse, in reading order
 *     (left before right). Empty when both documents are valid. When non-empty
 *     the panel shows the validation error state for the invalid document(s)
 *     instead of a list (Req 8.8).
 *   - `bothValid` — true only when *both* documents parse.
 *   - `differences` — the path-keyed differences when `bothValid`; `null` when
 *     a document failed to parse (validity undetermined).
 */
export interface SemanticDiffComputation {
  errors: DiffDocError[];
  bothValid: boolean;
  differences: Difference[] | null;
}

/** Human-readable name for a document side. */
function sideLabel(side: DiffDocSide): string {
  return side === 'left' ? 'Left' : 'Right';
}

/**
 * Convert a `JsonNode` subtree into a plain JSON value for a root-level
 * difference payload (used only for the empty-vs-non-empty edge case).
 */
function toPlain(node: JsonNode): unknown {
  switch (node.type) {
    case 'null':
      return null;
    case 'boolean':
      return node.boolValue ?? false;
    case 'string':
      return node.stringValue ?? '';
    case 'number':
      return Number(node.numberValue ?? '0');
    case 'array':
      return (node.children ?? []).map((child) => toPlain(child));
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const child of node.children ?? []) {
        result[String(child.key)] = toPlain(child);
      }
      return result;
    }
    default:
      return null;
  }
}

/**
 * Evaluate a Left/Right document text pair for the semantic diff list.
 *
 * Both documents are parsed with the shared, authoritative `parseJson`. A
 * document that fails to parse contributes a {@link DiffDocError} naming its
 * side, and short-circuits the computation so the panel shows the validation
 * error state for the invalid document instead of a list (Req 8.8). When both
 * documents parse, `semanticDiff` produces the path-keyed, classified
 * differences (Req 8.1).
 *
 * @param leftText  Raw text of the Left document.
 * @param rightText Raw text of the Right document.
 * @returns The {@link SemanticDiffComputation} describing what the panel shows.
 */
export function computeSemanticDiffView(
  leftText: string,
  rightText: string,
): SemanticDiffComputation {
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

  // A parse failure means the validation error state is shown (Req 8.8); no
  // list is produced.
  if (errors.length > 0) {
    return { errors, bothValid: false, differences: null };
  }

  // Both documents are valid. `parseJson` reports empty/whitespace-only input
  // as a valid-empty result with `model: null`.
  const leftModel = left.ok && !left.empty ? left.model : null;
  const rightModel = right.ok && !right.empty ? right.model : null;

  let differences: Difference[];
  if (leftModel !== null && rightModel !== null) {
    differences = semanticDiff(leftModel, rightModel);
  } else if (leftModel === null && rightModel === null) {
    // Both empty: structurally identical, no differences.
    differences = [];
  } else if (rightModel !== null) {
    // Left empty, Right present: the whole document was added at the root.
    differences = [{ path: '', kind: 'addition', right: toPlain(rightModel) }];
  } else {
    // Right empty, Left present: the whole document was deleted at the root.
    differences = [{ path: '', kind: 'deletion', left: toPlain(leftModel!) }];
  }

  return { errors: [], bothValid: true, differences };
}
