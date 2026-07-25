// Feature: json-viewer-free — MPA tool routing.
//
// Single source of truth mapping each of the four tools to a real, meaningful
// URL path (so the site is a true multi-page application, good for SEO) plus
// the per-page metadata each tool page renders.
//
// This replaces the old hash-based routing (`#tool=viewer`). Each tool now has
// its own crawlable page:
//
//   viewer    → /json-viewer
//   diff      → /json-diff
//   grid      → /json-to-table
//   converter → /json-converter
//
// Framework-agnostic: imported by the Astro pages (for metadata), the
// NavigationBar (for links) and AppShell (for keyboard navigation).

import type { Tool } from '../stores/document';

/** A tool's route + the SEO metadata its dedicated page renders. */
export interface ToolRoute {
  /** The tool this route activates. */
  tool: Tool;
  /** Root-relative URL path, e.g. `/json-viewer`. */
  path: string;
  /** Short label shown in the navigation bar. */
  label: string;
  /**
   * The descriptive brand suffix shown in the top bar next to the logo, after
   * "JSONLab — ", e.g. "JSON Viewer, Formatter & Validator". Reflects the tool
   * the current page represents.
   */
  navBrand: string;
  /** Page <title>. */
  title: string;
  /** Meta description for the page. */
  description: string;
  /** Comma-separated SEO keywords for the page. */
  keywords: string;
  /** Visible H1 / intro heading on the page. */
  heading: string;
  /** Short crawlable intro paragraph rendered under the workbench. */
  intro: string;
}

/**
 * The four tool routes, in navigation order. The order here is the single
 * source of truth for the navigation bar.
 */
export const TOOL_ROUTES: readonly ToolRoute[] = [
  {
    tool: 'viewer',
    path: '/json-viewer',
    label: 'JSON Viewer',
    navBrand: 'JSON Viewer, Formatter & Validator',
    title: 'JSON Viewer, Formatter, Validator & Beautifier — JSONLab',
    description:
      'Free online JSON viewer, formatter, beautifier and validator. View JSON as a collapsible tree, format and beautify it, and fix syntax errors — 100% in your browser.',
    keywords:
      'json viewer, json formatter, json validator, json beautifier, json editor, json parser, json tree viewer, format json, beautify json, validate json',
    heading: 'JSON Viewer, Formatter & Validator',
    intro:
      'View any JSON as a collapsible tree, beautify or minify it with one click, and validate it in real time with inline error messages and smart auto-fix. Everything runs locally in your browser — your data never leaves your machine.',
  },
  {
    tool: 'diff',
    path: '/json-diff',
    label: 'JSON Diff',
    navBrand: 'JSON Diff & Compare',
    title: 'JSON Diff Online — Compare & Find JSON Differences | JSONLab',
    description:
      'Compare two JSON files with a free JSON diff online tool. Find semantic differences, review changes side by side, merge edits and export RFC 6902 patches.',
    keywords:
      'json diff, json diff online, json diff checker, json diff tool, online json diff, json diff viewer, json diff compare, python json diff, json diff python, semantic json diff, json diff checker online, json diff check, json difference, json difference checker, json difference online, semantic JSON compare, json diff finder, compare json files, RFC 6902',
    heading: 'JSON Diff Online — Compare Two JSON Files',
    intro:
      'Compare two JSON documents with a semantic diff that ignores object key order and formatting. Review each added, removed or changed value side by side, merge edits, and export an RFC 6902 JSON Patch without uploading your data.',
  },
  {
    tool: 'grid',
    path: '/json-to-table',
    label: 'JSON to Table',
    navBrand: 'JSON to Table / Grid Viewer',
    title: 'JSON to Table Online — Convert JSON to a Table | JSONLab',
    description:
      'Convert JSON to a searchable, sortable table online. Filter an array of objects, resize columns, and download the current view as JSON or CSV.',
    keywords:
      'json to table, json to table converter, convert json to table, json to table online, excel json to table, python json to table, json to table viewer, excel convert json to table, json to table formatter, json to table visualizer, json grid, json array to table',
    heading: 'JSON to Table Online — Search, Sort and Export JSON Data',
    intro:
      'Turn a JSON array of objects into a searchable, sortable and filterable table. Resize columns, inspect nested values, and download the current filtered view as JSON or CSV without uploading your data.',
  },
  {
    tool: 'converter',
    path: '/json-converter',
    label: 'JSON Converter',
    navBrand: 'JSON Converter & Code Generator',
    title: 'JSON Converter Online — XML, CSV & YAML | JSONLab',
    description:
      'Use our free JSON converter online to convert JSON, XML, CSV, YAML and TOML both ways, generate typed code, and query data privately in your browser.',
    keywords:
      'json converter, xml to json converter, csv to json converter, yaml to json converter, json converter online, pdf to json converter, text to json converter, excel to json converter, txt to json converter, string to json converter, json converter to excel, json converter to word, json to xml, json to csv, json to yaml, json to toml, toml to json, JSONPath, JMESPath',
    heading: 'JSON Converter Online — XML, CSV, YAML, TOML & Code',
    intro:
      'Convert JSON to or from YAML, XML, CSV and TOML, generate typed models for five programming languages, and query documents with JSONPath or JMESPath. Processing stays in your browser.',
  },
  {
    tool: 'text',
    path: '/text-compare',
    label: 'Text Compare',
    navBrand: 'Text Compare & Diff',
    title: 'Text Compare Online — Free Text Difference Tool | JSONLab',
    description:
      'Compare two texts online with a free text compare tool. See every added, removed and changed line side by side or unified, privately in your browser.',
    keywords:
      'text-compare, text compare, text compare online, online text compare, text compare tool, online text compare tool, text compare online free, text compare tools, text compare online tool, text compare tool online, free text compare tool, compare two text files, text difference checker, line diff',
    heading: 'Text Compare Online — Free Side-by-Side Difference Tool',
    intro:
      'Compare two editable texts line by line, highlight additions, removals and changes, and switch between side-by-side and unified views. Open multiple comparison tabs while keeping every document in your browser.',
  },
] as const;

/** Lookup a route by tool id. */
export function routeForTool(tool: Tool): ToolRoute {
  const route = TOOL_ROUTES.find((r) => r.tool === tool);
  // Every Tool has a route, so this is only a defensive fallback.
  return route ?? TOOL_ROUTES[0];
}

/** The URL path for a tool, e.g. `routePath('viewer') === '/json-viewer'`. */
export function routePath(tool: Tool): string {
  return routeForTool(tool).path;
}
