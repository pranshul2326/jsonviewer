// Feature: json-viewer-free
//
// Text emitters for the `json-core` library:
//
//   format(model, style) : JsonNode -> pretty-printed JSON text
//   serialize(model)     : JsonNode -> compact (but valid) JSON text
//   minify(text)         : string   -> whitespace-stripped JSON text
//
// `format` and `serialize` walk the `JsonNode` tree directly rather than going
// through `JSON.stringify` on a plain JS object. This is deliberate: object
// members are stored as an *ordered* `children[]` array, and plain JS objects
// cannot preserve integer-like key order (Req 2.8, 5.5, 20.6). Walking the tree
// emits members in their stored order and re-emits numeric lexemes verbatim, so
// key order, array order, and numeric precision survive the round-trip.
//
// `minify` is a string-literal-aware scanner (Req 5.4): it removes whitespace
// (space, tab, newline, carriage return) that appears outside string literals
// while preserving every character — whitespace included — inside string
// literals.

import type { JsonNode } from './types';

/**
 * Indentation style for {@link format}:
 *   - `{ kind: 'space', size: 2 | 4 }` — 2 or 4 spaces per nesting level,
 *   - `{ kind: 'tab' }` — one horizontal tab per nesting level.
 */
export type IndentStyle = { kind: 'space'; size: 2 | 4 } | { kind: 'tab' };

/**
 * Escape a string value as a JSON string literal (including the surrounding
 * double quotes). Handles the mandatory short escapes and emits remaining
 * control characters (U+0000–U+001F) as `\u00XX`.
 */
function escapeString(value: string): string {
  let result = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    switch (ch) {
      case 0x22: // "
        result += '\\"';
        break;
      case 0x5c: // \
        result += '\\\\';
        break;
      case 0x08: // backspace
        result += '\\b';
        break;
      case 0x09: // tab
        result += '\\t';
        break;
      case 0x0a: // line feed
        result += '\\n';
        break;
      case 0x0c: // form feed
        result += '\\f';
        break;
      case 0x0d: // carriage return
        result += '\\r';
        break;
      default:
        if (ch < 0x20) {
          result += '\\u' + ch.toString(16).padStart(4, '0');
        } else {
          result += value[i];
        }
    }
  }
  return result + '"';
}

/** Emit a scalar node's text. Numbers re-emit their raw lexeme verbatim. */
function scalar(node: JsonNode): string {
  switch (node.type) {
    case 'null':
      return 'null';
    case 'boolean':
      return node.boolValue ? 'true' : 'false';
    case 'number':
      return node.numberValue ?? '0';
    case 'string':
      return escapeString(node.stringValue ?? '');
    default:
      // Not a scalar; callers guard against this.
      throw new Error(`Not a scalar JsonType: ${node.type}`);
  }
}

/** Emit the key portion of an object member (a quoted JSON string). */
function memberKey(node: JsonNode): string {
  return escapeString(String(node.key ?? ''));
}

/**
 * Serialize a {@link JsonNode} tree into compact, valid JSON text: no
 * insignificant whitespace, `:` between names and values, `,` between members
 * and elements. Object key order, array order, and numeric lexemes are
 * preserved verbatim.
 */
export function serialize(model: JsonNode): string {
  switch (model.type) {
    case 'object': {
      const members = (model.children ?? []).map(
        (child) => `${memberKey(child)}:${serialize(child)}`,
      );
      return `{${members.join(',')}}`;
    }
    case 'array': {
      const elements = (model.children ?? []).map((child) => serialize(child));
      return `[${elements.join(',')}]`;
    }
    default:
      return scalar(model);
  }
}

/** Build the per-level indentation unit for an {@link IndentStyle}. */
function indentUnit(style: IndentStyle): string {
  return style.kind === 'tab' ? '\t' : ' '.repeat(style.size);
}

/**
 * Pretty-print a {@link JsonNode} tree (Req 5.1–5.3). Each nested structural
 * level is indented by exactly one style-unit per depth level, and a single
 * space follows each name-value separator (the `:`). Empty objects and arrays
 * are emitted compactly as `{}` and `[]`. Key order, array order, and numeric
 * lexemes are preserved verbatim.
 */
export function format(model: JsonNode, style: IndentStyle): string {
  const unit = indentUnit(style);

  const walk = (node: JsonNode, depth: number): string => {
    switch (node.type) {
      case 'object': {
        const children = node.children ?? [];
        if (children.length === 0) {
          return '{}';
        }
        const inner = unit.repeat(depth + 1);
        const outer = unit.repeat(depth);
        const members = children.map(
          (child) => `${inner}${memberKey(child)}: ${walk(child, depth + 1)}`,
        );
        return `{\n${members.join(',\n')}\n${outer}}`;
      }
      case 'array': {
        const children = node.children ?? [];
        if (children.length === 0) {
          return '[]';
        }
        const inner = unit.repeat(depth + 1);
        const outer = unit.repeat(depth);
        const elements = children.map(
          (child) => `${inner}${walk(child, depth + 1)}`,
        );
        return `[\n${elements.join(',\n')}\n${outer}]`;
      }
      default:
        return scalar(node);
    }
  };

  return walk(model, 0);
}

/**
 * Remove insignificant whitespace from JSON text (Req 5.4).
 *
 * Scans `text` character by character, tracking whether the cursor is inside a
 * string literal. Outside string literals, the four JSON whitespace characters
 * (space, horizontal tab, line feed, carriage return) are dropped. Inside a
 * string literal every character is preserved verbatim, and escape sequences
 * (`\"`, `\\`, etc.) are honored so an escaped quote does not end the string.
 */
export function minify(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // Outside a string literal.
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      // Insignificant whitespace — drop it.
      continue;
    }

    result += ch;
  }

  return result;
}
