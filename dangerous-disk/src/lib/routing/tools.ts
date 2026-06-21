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
    title: 'JSON Diff & Compare Tool — Find Differences | JSONLab',
    description:
      'Free online JSON diff and compare tool. Semantically compare two JSON documents, see every difference side by side, merge changes and export an RFC 6902 patch — all in your browser.',
    keywords:
      'json diff, json compare, compare json, json difference, json merge, json patch, rfc 6902, semantic json diff, diff two json files',
    heading: 'JSON Diff & Compare',
    intro:
      'Compare two JSON documents semantically, so reordered keys are treated as identical and only real changes are highlighted. View differences side by side, merge changes, and export a standard RFC 6902 JSON Patch.',
  },
  {
    tool: 'grid',
    path: '/json-to-table',
    label: 'JSON to Table',
    navBrand: 'JSON to Table / Grid Viewer',
    title: 'JSON to Table / Grid Viewer — JSONLab',
    description:
      'Free online JSON to table converter. Turn an array of JSON objects into a searchable, sortable, filterable spreadsheet-style grid — entirely in your browser.',
    keywords:
      'json to table, json grid, json table viewer, json to spreadsheet, json array to table, view json as table',
    heading: 'JSON to Table / Grid Viewer',
    intro:
      'Transform an array of JSON objects into a searchable, sortable and filterable table. The grid view makes large datasets easy to scan and explore, all without uploading your data.',
  },
  {
    tool: 'converter',
    path: '/json-converter',
    label: 'JSON Converter',
    navBrand: 'JSON Converter & Code Generator',
    title: 'JSON Converter — JSON to CSV, YAML, XML & Code | JSONLab',
    description:
      'Free online JSON converter. Convert JSON to CSV, YAML, XML and TOML, generate TypeScript, Java, Go, Python and Dart code, and run JSONPath / JMESPath queries — in your browser.',
    keywords:
      'json converter, json to csv, json to yaml, json to xml, json to toml, json to typescript, json to java, json to go, json to python, jsonpath, jmespath',
    heading: 'JSON Converter & Code Generator',
    intro:
      'Convert JSON to CSV, YAML, XML and TOML, generate strongly-typed code for TypeScript, Java, Go, Python and Dart, and slice large datasets with JSONPath and JMESPath queries — all client-side.',
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
