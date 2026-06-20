/** @jsxImportSource preact */
// Feature: json-viewer-free — Task 13.3
//
// TypeBadge: a pure, presentational Preact component that renders exactly one
// type badge for a given JSON value type. Each of the six supported types
// (string, number, boolean, null, array, object) gets a distinct label and a
// distinct, token-driven color so that no two badges are visually identical
// (Req 3.1–3.7). Any value outside the six supported types renders a single
// unknown ("?") badge without throwing (Req 3.8).
//
// All colors come from the `--color-badge-*` design tokens defined in
// src/styles/theme.css, surfaced by Tailwind 4 `@theme` as `badge-*` color
// utilities. No hardcoded color values are used here (Req 22.1).

import type { JsonType } from '../../lib/json-core/types';

/**
 * Props for {@link TypeBadge}. `type` is normally one of the six `JsonType`
 * members, but a bare `string` is tolerated so that an unexpected/unsupported
 * value renders the defensive unknown badge instead of throwing (Req 3.8).
 */
export interface TypeBadgeProps {
  /** The JSON value type to render a badge for. */
  type: JsonType | (string & {});
}

/** Visual descriptor for a single badge: its label and full Tailwind classes. */
interface BadgeStyle {
  /** Short, distinct label identifying the type. */
  label: string;
  /** Human-readable type name for the accessible title/aria-label. */
  title: string;
  /**
   * Full (non-interpolated) Tailwind class string for color, so Tailwind's
   * scanner can statically detect every class. Each entry references a distinct
   * `--color-badge-*` token, guaranteeing mutual visual distinctness (Req 3.7).
   */
  className: string;
}

/**
 * One entry per supported {@link JsonType}. Each label and color token is
 * distinct from the other five (Req 3.1–3.7).
 */
const BADGE_STYLES: Record<JsonType, BadgeStyle> = {
  string: {
    label: 'str',
    title: 'string',
    className: 'text-badge-string bg-badge-string/10 ring-badge-string/30',
  },
  number: {
    label: 'num',
    title: 'number',
    className: 'text-badge-number bg-badge-number/10 ring-badge-number/30',
  },
  boolean: {
    label: 'bool',
    title: 'boolean',
    className: 'text-badge-bool bg-badge-bool/10 ring-badge-bool/30',
  },
  null: {
    label: 'null',
    title: 'null',
    className: 'text-badge-null bg-badge-null/10 ring-badge-null/30',
  },
  array: {
    label: '[]',
    title: 'array',
    className: 'text-badge-array bg-badge-array/10 ring-badge-array/30',
  },
  object: {
    label: '{}',
    title: 'object',
    className: 'text-badge-object bg-badge-object/10 ring-badge-object/30',
  },
};

/** Defensive fallback badge for any value outside the six supported types (Req 3.8). */
const UNKNOWN_BADGE: BadgeStyle = {
  label: '?',
  title: 'unknown type',
  className: 'text-mute bg-canvas-soft-2 ring-hairline-strong/40',
};

/** Shared layout classes applied to every badge regardless of type. */
const BASE_CLASS =
  'inline-flex items-center justify-center select-none font-mono ' +
  'text-caption font-medium rounded-xs px-1.5 leading-none h-5 min-w-5 ' +
  'ring-1 ring-inset';

/** Type guard: is `value` one of the six supported {@link JsonType} members? */
function isJsonType(value: string): value is JsonType {
  return Object.prototype.hasOwnProperty.call(BADGE_STYLES, value);
}

/**
 * Render exactly one type badge for the given `type`. Supported types use their
 * distinct label + token color; anything else falls back to the unknown badge.
 */
export function TypeBadge({ type }: TypeBadgeProps) {
  const style = isJsonType(type) ? BADGE_STYLES[type] : UNKNOWN_BADGE;

  return (
    <span
      class={`${BASE_CLASS} ${style.className}`}
      title={style.title}
      aria-label={`${style.title} type`}
      data-type={type}
    >
      {style.label}
    </span>
  );
}

export default TypeBadge;
