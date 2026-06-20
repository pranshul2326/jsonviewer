// Feature: json-viewer-free
//
// Property-based tests for the Viewer tree model exported from `TreePanel.tsx`:
//   - Property 4: Tree structure and child counts mirror the document
//                 (Req 1.1, 1.6, 1.9)
//   - Property 5: Expansion state transitions are well-defined
//                 (Req 1.2, 1.3, 1.4, 1.5, 1.8)
//
// Both properties exercise the pure flattening / expansion helpers
// (`flattenTree`, `collectExpandableIds`, `initialExpandedIds`, `isExpandable`)
// directly against documents drawn from the shared `jsonArbitrary`, with no DOM
// involved. The model's containment structure is reconstructed independently of
// the implementation (a depth stack and a parent map) so the tests verify the
// behavior rather than merely restating it.

import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';

import type { JsonNode } from '../../lib/json-core/types';
import {
  flattenTree,
  collectExpandableIds,
  initialExpandedIds,
  isExpandable,
  type FlatRow,
} from './TreePanel';
import { jsonArbitrary } from '../../test/arbitraries';

/** Every node in the tree, in pre-order (root first). */
function collectNodes(root: JsonNode): JsonNode[] {
  const out: JsonNode[] = [root];
  if (root.children) {
    for (const child of root.children) out.push(...collectNodes(child));
  }
  return out;
}

/** Map every node id to its parent node (the root maps to `null`). */
function buildParentMap(root: JsonNode): Map<string, JsonNode | null> {
  const map = new Map<string, JsonNode | null>();
  map.set(root.id, null);
  const walk = (node: JsonNode): void => {
    if (node.children) {
      for (const child of node.children) {
        map.set(child.id, node);
        walk(child);
      }
    }
  };
  walk(root);
  return map;
}

/** The ids of every ancestor of `node` (excluding the node itself). */
function ancestorIds(
  parentMap: Map<string, JsonNode | null>,
  node: JsonNode,
): Set<string> {
  const ids = new Set<string>();
  let parent = parentMap.get(node.id) ?? null;
  while (parent) {
    ids.add(parent.id);
    parent = parentMap.get(parent.id) ?? null;
  }
  return ids;
}

describe('Property 4: Tree structure and child counts mirror the document (Req 1.1, 1.6, 1.9)', () => {
  // With every expandable node expanded, the flattened tree must contain
  // exactly one row per document node; each row's parent (reconstructed from
  // the depth stream) must be its containing object/array; every container's
  // direct-child count must equal its number of children; and empty containers
  // must expose no expand control.
  test.prop([jsonArbitrary()], { numRuns: 100 })(
    'fully-expanded tree mirrors nodes, parents, child counts, and empty-container expandability',
    (model) => {
      const allNodes = collectNodes(model);
      const parentMap = buildParentMap(model);
      const rows = flattenTree(model, collectExpandableIds(model));

      // (Req 1.1) Exactly one row per key/value entry — same count, unique ids,
      // and the same id set as the document's nodes.
      expect(rows.length).toBe(allNodes.length);
      const rowIds = rows.map((r) => r.node.id);
      expect(new Set(rowIds).size).toBe(rows.length);
      expect(new Set(rowIds)).toEqual(new Set(allNodes.map((n) => n.id)));

      // (Req 1.1) Each node is rendered as a descendant of its containing
      // object/array. Reconstruct each row's parent from the depth stream and
      // tally direct children per parent for the child-count check below.
      const stack: FlatRow[] = [];
      const directChildCount = new Map<string, number>();
      for (const row of rows) {
        while (stack.length > 0 && stack[stack.length - 1].depth >= row.depth) {
          stack.pop();
        }
        const reconstructedParent =
          stack.length > 0 ? stack[stack.length - 1].node : null;
        const actualParent = parentMap.get(row.node.id) ?? null;

        expect(reconstructedParent?.id ?? null).toBe(actualParent?.id ?? null);
        if (actualParent) {
          expect(
            actualParent.type === 'object' || actualParent.type === 'array',
          ).toBe(true);
          expect(actualParent.children?.some((c) => c.id === row.node.id)).toBe(
            true,
          );
          directChildCount.set(
            actualParent.id,
            (directChildCount.get(actualParent.id) ?? 0) + 1,
          );
        }
        stack.push(row);
      }

      for (const node of allNodes) {
        if (node.type !== 'object' && node.type !== 'array') continue;
        const childCount = node.children?.length ?? 0;

        // (Req 1.6) The container's reported child count (the direct children
        // revealed when fully expanded) equals its number of direct children,
        // including 0 for an empty container.
        expect(directChildCount.get(node.id) ?? 0).toBe(childCount);

        // (Req 1.9) Empty containers expose no expand control; non-empty
        // containers do.
        expect(isExpandable(node)).toBe(childCount > 0);
        if (childCount === 0) {
          expect(
            rows.find((r) => r.node.id === node.id)?.hasChildren,
          ).toBe(false);
        }
      }

      return true;
    },
  );
});

describe('Property 5: Expansion state transitions are well-defined (Req 1.2, 1.3, 1.4, 1.5, 1.8)', () => {
  // The initial state expands only the root (Req 1.8); collapse-all leaves only
  // the root visible (Req 1.4); expand-all makes every node visible (Req 1.5);
  // and expanding a single container reveals exactly its direct children
  // (Req 1.2/1.3).
  test.prop([jsonArbitrary(), fc.nat()], { numRuns: 100 })(
    'initial, collapse-all, expand-all, and single-expand are well-defined',
    (model, rawIndex) => {
      const allNodes = collectNodes(model);
      const parentMap = buildParentMap(model);

      // (Req 1.8) Initial state: only the root is expanded (empty when the root
      // is itself not expandable — a scalar or empty container).
      const initial = initialExpandedIds(model);
      if (isExpandable(model)) {
        expect(initial).toEqual(new Set([model.id]));
      } else {
        expect(initial.size).toBe(0);
      }

      // Visible rows in the initial state are the root plus its direct children
      // (when the root is expandable) and nothing deeper.
      const initialIds = new Set(
        flattenTree(model, initial).map((r) => r.node.id),
      );
      const expectedInitialIds = new Set<string>([model.id]);
      if (isExpandable(model)) {
        for (const child of model.children!) expectedInitialIds.add(child.id);
      }
      expect(initialIds).toEqual(expectedInitialIds);

      // (Req 1.4) Collapse-all (empty set) leaves only the root row visible.
      const collapsed = flattenTree(model, new Set<string>());
      expect(collapsed.length).toBe(1);
      expect(collapsed[0].node.id).toBe(model.id);

      // (Req 1.5) Expand-all makes every node in the document visible.
      const expanded = flattenTree(model, collectExpandableIds(model));
      expect(expanded.length).toBe(allNodes.length);
      expect(new Set(expanded.map((r) => r.node.id))).toEqual(
        new Set(allNodes.map((n) => n.id)),
      );

      // (Req 1.2/1.3) Expanding a single container, with only its ancestors
      // expanded so it is visible, reveals exactly its direct children.
      const expandable = allNodes.filter(isExpandable);
      if (expandable.length > 0) {
        const target = expandable[rawIndex % expandable.length];
        const ancestors = ancestorIds(parentMap, target);

        const withoutRows = flattenTree(model, ancestors);
        const withRows = flattenTree(model, new Set([...ancestors, target.id]));

        // The target itself is visible before expanding (collapsed).
        expect(withoutRows.some((r) => r.node.id === target.id)).toBe(true);

        const beforeIds = new Set(withoutRows.map((r) => r.node.id));
        const revealed = withRows
          .map((r) => r.node.id)
          .filter((id) => !beforeIds.has(id));

        expect(revealed.length).toBe(target.children!.length);
        expect(new Set(revealed)).toEqual(
          new Set(target.children!.map((c) => c.id)),
        );
      }

      return true;
    },
  );
});
