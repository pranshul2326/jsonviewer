// Feature: json-viewer-free
//
// Core data-model types for the pure, framework-free `json-core` library.
// The `JsonNode` tree is the single in-memory representation that backs every
// tool. Its shape is chosen to satisfy the correctness properties the spec
// demands:
//   - Object members are stored as an *ordered* array of children, never a
//     plain JS object, so object key order is explicit and preserved through
//     edits and serialization (Req 2.8, 20.6).
//   - Numbers are carried as their original lexeme string (`numberValue`),
//     produced by `lossless-json`, so full numeric precision and big integers
//     survive round-trips (Req 20.6).

/** The six JSON value types supported by the data model. */
export type JsonType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null';

/**
 * A single node in the in-memory JSON document tree.
 *
 * Exactly one scalar carrier (`stringValue`, `numberValue`, or `boolValue`) is
 * populated for the corresponding scalar `type`; `null` nodes populate none of
 * them. Container nodes (`object`, `array`) populate `children` with an ordered
 * list and leave the scalar carriers undefined.
 */
export interface JsonNode {
  /** Stable id for tree identity (derived from the node's path). */
  id: string;
  /**
   * The node's key relative to its parent:
   *   - the object property name (`string`) when the parent is an object,
   *   - the array index (`number`) when the parent is an array,
   *   - `null` at the document root.
   */
  key: string | number | null;
  /** The JSON type of this node's value. */
  type: JsonType;

  // Scalar carriers (exactly one populated for the matching scalar type):
  /** Populated when `type === 'string'`. */
  stringValue?: string;
  /**
   * Populated when `type === 'number'`. Holds the raw numeric lexeme from
   * `lossless-json` (e.g. `"12345678901234567890"`, `"1.0"`, `"1e2"`) so that
   * precision is preserved verbatim.
   */
  numberValue?: string;
  /** Populated when `type === 'boolean'`. */
  boolValue?: boolean;

  // Container carrier:
  /** Ordered child nodes; preserves source order. Present for objects/arrays. */
  children?: JsonNode[];
}

/**
 * The shape of the value tree produced by `lossless-json`'s `parse` (and
 * consumed by its `stringify`). Numbers are represented as `LosslessNumber`
 * instances; objects are plain records and arrays are plain arrays.
 *
 * Declared structurally (rather than importing the concrete type) so that this
 * module's types do not hard-depend on the package being installed. The runtime
 * conversions in `model.ts` use the package's `LosslessNumber`/`isLosslessNumber`.
 */
export type LosslessValue =
  | string
  | boolean
  | null
  | LosslessNumberLike
  | LosslessValue[]
  | { [key: string]: LosslessValue };

/**
 * Minimal structural description of a `lossless-json` `LosslessNumber`: an
 * object exposing the raw numeric lexeme as a string `value`.
 */
export interface LosslessNumberLike {
  readonly value: string;
  isLosslessNumber?: boolean;
}
