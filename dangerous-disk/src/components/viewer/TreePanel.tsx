/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 13.1
//
// TreePanel: the virtualized, collapsible tree model for the Viewer (Req 1).
//
// This component owns three concerns and nothing more (the richer per-row UI —
// type badges, inline editing, path copy, rich-media — is TreeRow, task 13.5):
//
//   1. Flattening — given a root `JsonNode` and an `expandedIds` set, derive the
//      depth-first list of *visible* rows, including a container's children only
//      when that container is expanded (Req 1.2/1.3).
//   2. Expansion state — root expanded and every other expandable node collapsed
//      on first render (Req 1.8); single-node expand/collapse (Req 1.2/1.3);
//      expand-all (Req 1.5) and collapse-all (Req 1.4).
//   3. Virtualization — windowed rendering of the flattened list via
//      `@tanstack/virtual-core` so very large trees stay performant; only the
//      on-screen rows are mounted.
//
// The flattening and expansion-set helpers are exported as pure functions so the
// property tests in task 13.2 can exercise them directly without a DOM. The row
// rendering here is intentionally minimal (indentation, a caret for expandable
// nodes, the key, and a short value preview); a `renderRow` slot lets task 13.5
// drop in the full `TreeRow` without changing this component.

import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from '@tanstack/virtual-core';
import type { JsonNode } from '../../lib/json-core/types';

/** Estimated pixel height of a single tree row; drives the virtual window. */
export const ROW_HEIGHT = 24;

/** Number of extra rows rendered above/below the viewport for smooth scroll. */
const OVERSCAN = 12;

/**
 * A single entry in the flattened, visible-row list produced from the tree.
 *
 * `depth` is 0 at the root and increases by one per nesting level. `hasChildren`
 * is true only for *non-empty* containers — empty objects/arrays expose no
 * expand control (Req 1.9). `expanded` is true only when the node both has
 * children and is currently expanded.
 */
export interface FlatRow {
  /** The underlying document node for this row. */
  node: JsonNode;
  /** Nesting depth; 0 for the root node. */
  depth: number;
  /** Whether this node is currently expanded (always false when no children). */
  expanded: boolean;
  /** Whether this node is an expandable, non-empty container. */
  hasChildren: boolean;
}

/**
 * True when `node` is an expandable container: an object or array that has at
 * least one child. Empty containers are intentionally *not* expandable so the
 * Tree_View renders them without an expand control (Req 1.9).
 */
export function isExpandable(node: JsonNode): boolean {
  return (
    (node.type === 'object' || node.type === 'array') &&
    Array.isArray(node.children) &&
    node.children.length > 0
  );
}

/**
 * Flatten the tree rooted at `root` into the depth-first list of rows that are
 * currently visible given `expandedIds`.
 *
 * The root row is always present. A container's children are included only when
 * the container is expandable and its id is in `expandedIds` (Req 1.2/1.3).
 * Implemented iteratively with an explicit stack so deeply nested documents do
 * not risk a call-stack overflow.
 */
export function flattenTree(
  root: JsonNode | null | undefined,
  expandedIds: ReadonlySet<string>,
): FlatRow[] {
  if (!root) return [];

  const rows: FlatRow[] = [];
  // Stack holds nodes still to emit, in reverse visual order so `pop()` yields
  // pre-order depth-first traversal.
  const stack: Array<{ node: JsonNode; depth: number }> = [{ node: root, depth: 0 }];

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const hasChildren = isExpandable(node);
    const expanded = hasChildren && expandedIds.has(node.id);

    rows.push({ node, depth, expanded, hasChildren });

    if (expanded && node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], depth: depth + 1 });
      }
    }
  }

  return rows;
}

/**
 * The set of ids of every expandable node in the tree — used to implement
 * expand-all (Req 1.5). Empty containers are excluded since they cannot expand.
 */
export function collectExpandableIds(root: JsonNode | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!root) return ids;

  const stack: JsonNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isExpandable(node)) {
      ids.add(node.id);
      // Only containers have children to recurse into.
      for (const child of node.children!) stack.push(child);
    }
  }

  return ids;
}

/**
 * The initial expansion set for a freshly rendered document: only the root node
 * is expanded; every other expandable node starts collapsed (Req 1.8). If the
 * root is not expandable (a scalar or empty container) the set is empty.
 */
export function initialExpandedIds(root: JsonNode | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (root && isExpandable(root)) ids.add(root.id);
  return ids;
}

/** Imperative controls TreePanel surfaces to its parent (e.g. ViewerPanel). */
export interface TreePanelApi {
  /** Expand every expandable node so all rows are visible (Req 1.5). */
  expandAll: () => void;
  /** Collapse everything so only the root row remains visible (Req 1.4). */
  collapseAll: () => void;
}

/** Handlers passed to a custom {@link TreePanelProps.renderRow}. */
export interface RowHandlers {
  /** Toggle the expanded/collapsed state of the row's node (Req 1.2/1.3). */
  toggle: (id: string) => void;
}

/** Props for {@link TreePanel}. */
export interface TreePanelProps {
  /** The document root produced by the parser. `null` renders nothing. */
  root: JsonNode | null | undefined;
  /** Show the built-in expand-all / collapse-all toolbar. Defaults to `true`. */
  showControls?: boolean;
  /** Receives the imperative {@link TreePanelApi} once mounted (e.g. for ViewerPanel). */
  onApi?: (api: TreePanelApi) => void;
  /**
   * Optional row renderer. Task 13.5 slots the full `TreeRow` here; when omitted
   * a minimal inline row is rendered (caret, key, short value preview).
   */
  renderRow?: (row: FlatRow, handlers: RowHandlers) => VNode;
}

/**
 * A short, read-only preview of a node's value for the minimal inline row.
 * Containers show their direct child count (Req 1.6); scalars show their value.
 */
function previewValue(node: JsonNode): string {
  switch (node.type) {
    case 'object':
      return `{ ${node.children?.length ?? 0} }`;
    case 'array':
      return `[ ${node.children?.length ?? 0} ]`;
    case 'string':
      return JSON.stringify(node.stringValue ?? '');
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

/** The label shown for a row's key: the property name, array index, or `$` at root. */
function keyLabel(node: JsonNode): string {
  if (node.key === null) return '$';
  return String(node.key);
}

/**
 * Preact binding for the framework-agnostic `@tanstack/virtual-core`
 * `Virtualizer`. Constructs the instance once, keeps its options in sync each
 * render, wires its lifecycle to layout effects, and forces a re-render whenever
 * the virtualizer reports a change (scroll, resize, measurement).
 */
function useVirtualizer(
  count: number,
  getScrollElement: () => HTMLElement | null,
): Virtualizer<HTMLElement, Element> {
  // A monotonically increasing tick used purely to force a re-render whenever
  // the virtualizer reports a change. `useState`'s functional updater takes no
  // action argument, so `forceRender()` is callable with no args.
  const [, setTick] = useState(0);
  const forceRender = () => setTick((n) => n + 1);

  const virtualizer = useState(
    () =>
      new Virtualizer<HTMLElement, Element>({
        count,
        getScrollElement,
        estimateSize: () => ROW_HEIGHT,
        overscan: OVERSCAN,
        scrollToFn: elementScroll,
        observeElementRect,
        observeElementOffset,
        onChange: () => forceRender(),
      }),
  )[0];

  // Keep options current (count changes as rows expand/collapse).
  virtualizer.setOptions({
    ...virtualizer.options,
    count,
    getScrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    onChange: () => forceRender(),
  });

  // Mount once; recompute measurements on every render.
  useLayoutEffect(() => virtualizer._didMount(), []);
  useLayoutEffect(() => {
    virtualizer._willUpdate();
  });

  return virtualizer;
}

/**
 * The virtualized collapsible tree. Manages `expandedIds` as local state seeded
 * from {@link initialExpandedIds} and resets it whenever the root document
 * changes, so a freshly parsed model always starts with only the root expanded
 * (Req 1.8).
 */
export function TreePanel({ root, showControls = true, onApi, renderRow }: TreePanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => initialExpandedIds(root));

  // Re-seed expansion to the initial state (only root expanded, Req 1.8)
  // whenever a new document is loaded, keyed on the root node's identity.
  const rootId = root?.id;
  useLayoutEffect(() => {
    setExpandedIds(initialExpandedIds(root));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId]);

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => setExpandedIds(collectExpandableIds(root));
  const collapseAll = () => setExpandedIds(new Set<string>());

  // Surface imperative controls to the parent (e.g. ViewerPanel, task 13.9).
  useLayoutEffect(() => {
    onApi?.({ expandAll, collapseAll });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onApi, root]);

  const rows = useMemo(() => flattenTree(root, expandedIds), [root, expandedIds]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer(rows.length, () => scrollRef.current);
  const virtualItems = virtualizer.getVirtualItems();

  if (!root) {
    return (
      <div class="flex min-h-[40vh] items-center justify-center text-body-sm text-mute">
        No document to display
      </div>
    );
  }

  return (
    <div class="flex flex-col">
      {showControls ? (
        <div class="flex items-center gap-xs border-b border-hairline px-sm py-xs">
          <button
            type="button"
            class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft"
            onClick={expandAll}
          >
            Expand all
          </button>
          <button
            type="button"
            class="rounded-xs px-xs py-xxs text-button-md text-body ring-1 ring-inset ring-hairline hover:bg-canvas-soft"
            onClick={collapseAll}
          >
            Collapse all
          </button>
          <span class="ml-auto text-caption text-mute">{rows.length} rows</span>
        </div>
      ) : null}

      <div ref={scrollRef} class="relative max-h-[85vh] overflow-auto">
        <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualItems.map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            return (
              <div
                key={row.node.id}
                data-index={vi.index}
                class="absolute left-0 top-0 w-full"
                style={{
                  height: `${vi.size}px`,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {renderRow ? renderRow(row, { toggle }) : <MinimalRow row={row} toggle={toggle} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * The default minimal row used until the full `TreeRow` (task 13.5) is slotted
 * in. Renders indentation by depth, an expand/collapse caret for expandable
 * nodes (and only those — empty containers show no caret, Req 1.9), the key, and
 * a short value preview.
 */
function MinimalRow({ row, toggle }: { row: FlatRow; toggle: (id: string) => void }) {
  const { node, depth, expanded, hasChildren } = row;
  // 16px of indentation per depth level, plus a fixed gutter for the caret.
  const indent = depth * 16;

  return (
    <div
      class="flex h-full items-center gap-xs px-sm font-mono text-code hover:bg-canvas-soft"
      style={{ paddingLeft: `${8 + indent}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          class="inline-flex h-4 w-4 shrink-0 items-center justify-center text-mute hover:text-ink"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
          onClick={() => toggle(node.id)}
        >
          {expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span class="inline-block h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span class="shrink-0 text-ink">{keyLabel(node)}</span>
      <span class="text-mute">:</span>
      <span class="truncate text-body">{previewValue(node)}</span>
    </div>
  );
}

export default TreePanel;
