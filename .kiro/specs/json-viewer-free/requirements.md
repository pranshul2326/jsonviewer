# Requirements Document

## Introduction

Json Viewer Free (jsonviewerfree.com) is an all-in-one, privacy-first, client-side web application for working with JSON. The product combines a JSON viewer/editor, formatter/minifier, validator with smart auto-repair, semantic diff/merge, rich-media type inference, multi-format converters, code generators, a tabular grid view, and expression-based querying into a single clean suite built with AstroJS, the Monaco editor, and Tailwind 4. All data processing happens entirely in the browser so user data never leaves the machine. The application is engineered for large payloads through background processing and follows a Vercel-inspired visual design.

This document defines the functional and quality requirements for the application. Implementation details (component structure, libraries, algorithms) are intentionally deferred to the design phase.

## Glossary

- **Application**: The Json Viewer Free web application as a whole, running entirely in the user's browser.
- **Editor**: The text-input surface based on the Monaco editor where users type or paste JSON.
- **Parser**: The Application subsystem that converts JSON text into an in-memory data model.
- **Serializer**: The Application subsystem that converts an in-memory data model into JSON text.
- **Tree_View**: The collapsible hierarchical visualization of a parsed JSON document.
- **Node**: A single key/value entry within the Tree_View (an object property, array element, or scalar value).
- **JSON_Path**: A string addressing a Node, in either dot-notation (e.g., `store.book[0].author`) or bracket-notation (e.g., `["store"]["book"][0]["author"]`).
- **Formatter**: The Application subsystem that re-indents JSON text according to a chosen indentation style.
- **Minifier**: The Application subsystem that removes insignificant whitespace from JSON text.
- **Validator**: The Application subsystem that checks JSON text for syntax correctness.
- **Smart_Fixer**: The Application subsystem that automatically repairs common JSON syntax mistakes.
- **Diff_Engine**: The Application subsystem that computes structural (semantic) differences between two JSON documents.
- **Three_Way_Merge**: The Application subsystem that reconciles a Left and Right document against a common Base document.
- **JSON_Patch**: A difference description conforming to the RFC 6902 JSON Patch format.
- **Converter**: The Application subsystem that transforms JSON to and from YAML, XML, CSV, and TOML.
- **Code_Generator**: The Application subsystem that produces typed source code from a JSON document.
- **Grid_View**: The Application subsystem that renders an array of objects as a searchable, filterable table.
- **Query_Engine**: The Application subsystem that evaluates JSONPath and JMESPath expressions against a JSON document.
- **Background_Worker**: A browser Web Worker used to perform processing off the main UI thread.
- **Share_Link**: A URL whose hash fragment encodes the current JSON payload and tool state.
- **Navigation_Bar**: The single top-level navigation grouping the primary tools (Viewer, Diff Checker, Table Grid, Converter).
- **Large_Document**: A JSON document whose serialized size is 5 MB or greater.

## Requirements

### Requirement 1: JSON Viewer and Collapsible Tree View

**User Story:** As a developer, I want to view JSON as a collapsible tree, so that I can explore nested structures without reading raw text.

#### Acceptance Criteria

1. WHEN the Editor content changes to valid JSON text, THE Parser SHALL produce an in-memory data model containing one Node per key/value entry in the source document, and THE Tree_View SHALL render the data model as a nested hierarchy in which each Node is displayed as a descendant of the Node corresponding to its containing object or array.
2. WHEN a user activates the expand control on a Node representing an object or array, THE Tree_View SHALL display all direct child Nodes of that Node.
3. WHEN a user activates the collapse control on an expanded Node, THE Tree_View SHALL hide all descendant Nodes of that Node.
4. WHEN a user requests "collapse all", THE Tree_View SHALL set every expandable Node to the collapsed state such that no descendant Node is displayed and only the root Node remains visible.
5. WHEN a user requests "expand all", THE Tree_View SHALL set every expandable Node to the expanded state such that every Node in the data model is displayed.
6. WHERE a Node represents an object or array, THE Tree_View SHALL display the count of that Node's direct child Nodes, displaying a count of 0 for an empty object or empty array.
7. IF the Editor content is not valid JSON, THEN THE Tree_View SHALL display the validation error state defined in Requirement 6 instead of a tree.
8. WHEN the Tree_View first renders a newly parsed data model, THE Tree_View SHALL display the root Node in the expanded state and every other expandable Node in the collapsed state.
9. WHERE a Node represents an empty object or an empty array, THE Tree_View SHALL render that Node without an expand control.

### Requirement 2: Interactive Node Manipulation

**User Story:** As a developer, I want to edit the JSON structure directly in the tree, so that I can modify data without hand-editing raw text.

#### Acceptance Criteria

1. WHEN a user adds a new key to an object Node through the Tree_View and the key does not already exist within that object, THE Application SHALL insert a new entry consisting of the user-provided key and value into the data model and update the Editor text to reflect the change.
2. WHEN a user deletes a Node through the Tree_View, THE Application SHALL remove the corresponding entry from the data model and update the Editor text to reflect the change.
3. WHEN a user renames a key of an object Node through the Tree_View to a name that does not already exist within the same object, THE Application SHALL update the corresponding key in the data model and update the Editor text to reflect the change.
4. WHEN a user edits the value of a scalar Node through the Tree_View to a valid JSON scalar (string, number, boolean, or null), THE Application SHALL update the corresponding value in the data model and update the Editor text to reflect the change.
5. IF a user attempts to rename an object key to a name that already exists within the same object, THEN THE Application SHALL reject the rename, leave every key and value of that object unchanged, and display an error message indicating the rename was rejected and identifying the conflicting key.
6. IF a user attempts to add a key that already exists within the same object, THEN THE Application SHALL reject the addition, leave every key and value of that object unchanged, and display an error message indicating the addition was rejected and identifying the conflicting key.
7. IF a user attempts to edit a scalar Node value to a value that cannot be interpreted as a valid JSON scalar, THEN THE Application SHALL reject the edit, leave the Node value unchanged, and display an error message indicating the entered value is not a valid JSON scalar.
8. WHEN the data model is modified through the Tree_View, THE Serializer SHALL produce JSON text that, when parsed, yields a data model equivalent to the modified data model (round-trip property).

### Requirement 3: Data Type Indicators

**User Story:** As a developer, I want visual indicators of each value's data type, so that I can quickly distinguish strings, numbers, booleans, arrays, and objects.

#### Acceptance Criteria

1. WHEN the Tree_View renders a Node whose value is a string, THE Tree_View SHALL display exactly one type badge on that Node labeled to identify the string type.
2. WHEN the Tree_View renders a Node whose value is a number, THE Tree_View SHALL display exactly one type badge on that Node labeled to identify the number type.
3. WHEN the Tree_View renders a Node whose value is a boolean, THE Tree_View SHALL display exactly one type badge on that Node labeled to identify the boolean type.
4. WHEN the Tree_View renders a Node whose value is null, THE Tree_View SHALL display exactly one type badge on that Node labeled to identify the null type.
5. WHEN the Tree_View renders a Node whose value is an array, THE Tree_View SHALL display exactly one type badge on that Node labeled to identify the array type.
6. WHEN the Tree_View renders a Node whose value is an object, THE Tree_View SHALL display exactly one type badge on that Node labeled to identify the object type.
7. THE Tree_View SHALL render the type badge for each of the six supported data types (string, number, boolean, null, array, object) with a label and visual style distinct from the badges of the other five data types, such that no two type badges are visually identical.
8. IF a Node value does not match any of the six supported data types (string, number, boolean, null, array, object), THEN THE Tree_View SHALL display a single type badge labeled to indicate an unknown or unsupported type without raising an error or omitting the Node.

### Requirement 4: Copy JSON Path

**User Story:** As a developer, I want to copy the path to any node, so that I can reference exact locations in my code or queries.

#### Acceptance Criteria

1. WHEN a user requests the dot-notation path of a Node, THE Application SHALL compute the dot-notation JSON_Path of that Node, beginning at the document root, and write it to the system clipboard.
2. WHEN a user requests the bracket-notation path of a Node, THE Application SHALL compute the bracket-notation JSON_Path of that Node, beginning at the document root, where every array index is rendered as a bracketed integer and every object key is rendered as a bracketed quoted string, and write it to the system clipboard.
3. WHEN a JSON_Path is successfully written to the clipboard, THE Application SHALL display a visible confirmation indicator within 500 milliseconds and SHALL keep that indicator visible for at least 2 seconds before dismissing it.
4. IF writing the JSON_Path to the system clipboard fails, THEN THE Application SHALL display an error indication informing the user that the copy did not complete, and the current displayed document SHALL remain unchanged.
5. WHERE an object key in a dot-notation path is empty or contains any character outside the set of ASCII letters (A-Z, a-z), ASCII digits (0-9), and underscore (_), or begins with an ASCII digit, THE Application SHALL render that key as a bracketed quoted segment within the dot-notation path; otherwise THE Application SHALL render the key as a dot-prefixed segment.
6. WHEN the dot-notation or bracket-notation path of a Node is computed, THE Application SHALL produce a JSON_Path that, when evaluated against the source document, resolves to exactly the value of that Node (path-correctness property).

### Requirement 5: Formatter, Beautifier, and Minifier

**User Story:** As a developer, I want to beautify or minify JSON, so that I can produce readable output or compact production payloads.

#### Acceptance Criteria

1. WHEN a user selects the 2-space indentation style and requests formatting, THE Formatter SHALL re-indent each nested structural level of the JSON text using 2 space characters per level and place a single space character after each name-value separator.
2. WHEN a user selects the 4-space indentation style and requests formatting, THE Formatter SHALL re-indent each nested structural level of the JSON text using 4 space characters per level and place a single space character after each name-value separator.
3. WHEN a user selects the tab indentation style and requests formatting, THE Formatter SHALL re-indent each nested structural level of the JSON text using one horizontal tab character per level and place a single space character after each name-value separator.
4. WHEN a user requests minification, THE Minifier SHALL remove all whitespace characters (space, horizontal tab, newline, and carriage return) that occur outside of string literals, while preserving all whitespace characters that occur inside string literals.
5. FOR ALL valid JSON inputs, parsing the formatted output SHALL yield a data model equivalent to parsing the original input (formatting round-trip property).
6. FOR ALL valid JSON inputs, parsing the minified output SHALL yield a data model equivalent to parsing the original input (minification round-trip property).
7. IF the Editor content is not valid JSON WHEN a user requests formatting or minification, THEN THE Application SHALL display the validation error state defined in Requirement 6 and leave the Editor content byte-for-byte unchanged.
8. IF the Editor content is empty or contains only whitespace characters WHEN a user requests formatting or minification, THEN THE Application SHALL display the validation error state defined in Requirement 6 and leave the Editor content byte-for-byte unchanged.
9. WHEN a user requests formatting or minification of valid JSON of up to 5,000,000 characters, THE Application SHALL produce the transformed output within 3 seconds.

### Requirement 6: Validation and Linting

**User Story:** As a developer, I want real-time validation with precise error locations, so that I can find and fix syntax problems quickly.

#### Acceptance Criteria

1. WHEN the Editor content changes and no further change occurs within 300 milliseconds, THE Validator SHALL evaluate the content for JSON syntax correctness and complete the evaluation within 500 milliseconds for content up to 5 MB in size.
2. WHERE the Editor content is valid JSON, THE Validator SHALL display a valid-state indicator that is visually distinct from the error-state indicator.
3. WHILE the Editor content is empty or contains only whitespace, THE Validator SHALL display the valid-state indicator and SHALL NOT display any error indicator.
4. IF the Editor content contains one or more syntax errors, THEN THE Validator SHALL display, for the first error encountered in reading order, an error description identifying the error type together with the 1-based line number and 1-based column number of the error location.
5. IF the Editor content contains a syntax error, THEN THE Editor SHALL highlight the character position at the reported line and column of the first error inline within the content.
6. WHEN the Editor content changes from invalid to valid, THE Validator SHALL clear all previously displayed error descriptions and inline error highlights within 500 milliseconds.

### Requirement 7: Smart Fixer

**User Story:** As a developer, I want a one-click repair for common JSON mistakes, so that I can recover malformed payloads without manual editing.

#### Acceptance Criteria

1. WHEN a user activates the Smart_Fixer on Editor text containing one or more trailing commas, THE Smart_Fixer SHALL remove every trailing comma from the text.
2. WHEN a user activates the Smart_Fixer on Editor text containing one or more unquoted object keys, THE Smart_Fixer SHALL enclose every unquoted object key in double quotes.
3. WHEN a user activates the Smart_Fixer on Editor text using single quotes as string delimiters, THE Smart_Fixer SHALL replace every single-quote string delimiter with a double quote.
4. WHEN a user activates the Smart_Fixer on text containing more than one category of correctable mistake, THE Smart_Fixer SHALL apply the corrections for all detected categories within a single activation.
5. WHEN the Smart_Fixer transforms the text into valid JSON, THE Smart_Fixer SHALL replace the Editor content with the corrected JSON text.
6. WHEN the Smart_Fixer produces a corrected result, THE Application SHALL display a summary that lists each category of correction applied and the count of corrections made within each category, and that states when no corrections were needed.
7. IF the Smart_Fixer cannot transform the text into valid JSON, THEN THE Smart_Fixer SHALL leave the Editor content unchanged and display a message identifying the line number and column number of the first remaining error.
8. WHEN the Smart_Fixer produces a corrected result, THE result SHALL be valid JSON as confirmed by the Validator.

### Requirement 8: Semantic Diff Comparison

**User Story:** As a developer, I want to compare two JSON documents by structure, so that differences in key order or formatting do not produce false differences.

#### Acceptance Criteria

1. WHEN a user provides a valid Left document and a valid Right document for comparison, THE Diff_Engine SHALL compute a set of differences in which each difference identifies a JSON_Path and is classified as exactly one of addition, deletion, or modification.
2. WHERE the Left and Right documents differ only in object key ordering, THE Diff_Engine SHALL report zero differences.
3. WHERE the Left and Right documents differ only in whitespace occurring outside of string values, THE Diff_Engine SHALL report zero differences.
4. WHEN a JSON_Path resolves to a value in the Right document but does not resolve in the Left document, THE Diff_Engine SHALL classify that difference as an addition.
5. WHEN a JSON_Path resolves to a value in the Left document but does not resolve in the Right document, THE Diff_Engine SHALL classify that difference as a deletion.
6. WHEN a JSON_Path resolves to differing scalar values in the Left and Right documents, THE Diff_Engine SHALL classify that difference as a modification.
7. FOR ALL pairs of valid JSON documents, IF the Diff_Engine reports zero differences, THEN the two documents SHALL be structurally equivalent, where structural equivalence means every JSON_Path resolves to the same scalar value in both documents irrespective of object key ordering and whitespace outside of string values (diff-soundness property).
8. IF either document provided for comparison is not valid JSON, THEN THE Application SHALL display the validation error state defined in Requirement 6 for the invalid document.

### Requirement 9: Diff Visualization

**User Story:** As a developer, I want side-by-side and unified diff views, so that I can review changes in the layout I prefer.

#### Acceptance Criteria

1. WHEN a user selects the side-by-side view, THE Application SHALL display the left document and right document in two adjacent panes, with each line rendered at the same vertical position in both panes so that corresponding and differing lines are horizontally aligned, within 1 second for documents up to 5 MB each.
2. WHEN a user selects the unified view, THE Application SHALL display both documents merged into a single pane in which added lines, deleted lines, and unchanged lines appear in their combined sequential order, within 1 second for documents up to 5 MB each.
3. WHERE a difference is an addition, THE Application SHALL render the added content with the addition indicator style that is visually distinct from the deletion indicator style and the modification indicator style.
4. WHERE a difference is a deletion, THE Application SHALL render the deleted content with the deletion indicator style that is visually distinct from the addition indicator style and the modification indicator style.
5. WHERE a difference is a modification, THE Application SHALL render the modification indicator style on both the left content and the right content, distinct from the addition and deletion indicator styles.
6. WHEN the two documents are identical, THE Application SHALL display all content without any addition, deletion, or modification indicators and SHALL display a message indicating that no differences were found.
7. IF either document fails to load or cannot be parsed for comparison, THEN THE Application SHALL display an error message indicating which document could not be processed and SHALL retain any previously displayed diff result.

### Requirement 10: JSON Patch Export

**User Story:** As a developer, I want to export the difference as an RFC 6902 JSON Patch, so that I can apply the change programmatically.

#### Acceptance Criteria

1. WHEN a user requests JSON Patch export for a computed difference between two valid JSON documents, THE Diff_Engine SHALL produce, within 2 seconds for documents up to 5 MB each, a JSON_Patch that is a JSON array whose every element conforms to RFC 6902 (each element containing a valid "op" of add, remove, replace, move, copy, or test, together with the member fields required by that operation).
2. FOR ALL pairs of valid JSON documents, applying the produced JSON_Patch to the left document SHALL yield a document structurally equivalent to the right document, where structural equivalence means equal object members irrespective of member ordering, equal array elements in the same order, and equal scalar values and types (patch-correctness property).
3. WHEN the left and right documents are structurally equivalent, THE Diff_Engine SHALL produce an empty JSON_Patch array (length 0).
4. WHEN a JSON_Patch is produced, THE Application SHALL provide a control that allows the user to copy the complete JSON_Patch text to the system clipboard.
5. WHEN the user copies the JSON_Patch to the system clipboard and the clipboard write completes, THE Application SHALL display a confirmation indication to the user within 1 second.
6. IF the clipboard write fails or clipboard access is denied, THEN THE Application SHALL display an error indication identifying that the copy did not complete, and SHALL retain the displayed JSON_Patch unchanged.

### Requirement 11: Three-Way Merge

**User Story:** As a developer, I want to merge a Left and Right version against a common Base, so that I can resolve data conflicts.

#### Acceptance Criteria

1. WHEN a user provides valid Base, Left, and Right documents, THE Three_Way_Merge SHALL compute a merged document that incorporates every non-conflicting change, where a non-conflicting change is a JSON_Path changed in Left only, changed in Right only, or changed identically in both Left and Right relative to Base.
2. WHERE a JSON_Path resolves to a value in Left that is not structurally equivalent to its Base value and resolves to a value in Right that is structurally equivalent to its Base value, THE Three_Way_Merge SHALL apply the Left value at that JSON_Path in the merged document.
3. WHERE a JSON_Path resolves to a value in Right that is not structurally equivalent to its Base value and resolves to a value in Left that is structurally equivalent to its Base value, THE Three_Way_Merge SHALL apply the Right value at that JSON_Path in the merged document.
4. WHERE a JSON_Path resolves to values in both Left and Right that are structurally equivalent to each other but not structurally equivalent to the Base value, THE Three_Way_Merge SHALL apply that common value at that JSON_Path in the merged document without marking a conflict.
5. WHERE a JSON_Path resolves to values in Left and Right that are not structurally equivalent to each other and at least one of them is not structurally equivalent to the Base value, THE Three_Way_Merge SHALL mark the JSON_Path as a conflict and present the Base, Left, and Right values for that JSON_Path.
6. WHEN a user selects the Base, Left, or Right value as the resolution for a conflicting JSON_Path, THE Three_Way_Merge SHALL apply the selected value at that JSON_Path in the merged document and clear the conflict mark for that JSON_Path.
7. IF unresolved conflicts remain WHEN a user requests the merged output, THEN THE Application SHALL display the count of unresolved conflicts and block export of the merged document.
8. WHEN a user requests the merged output and no unresolved conflicts remain, THE Application SHALL produce the merged document for export.
9. IF any of the Base, Left, or Right documents is not valid JSON, THEN THE Application SHALL display the validation error state defined in Requirement 6 for each invalid document.

### Requirement 12: Rich Media Type Inference

**User Story:** As a developer, I want recognizable string values rendered with helpful previews, so that I can understand data at a glance.

#### Acceptance Criteria

1. WHERE a string Node value matches an image URL pattern (a URL beginning with "http://" or "https://" and ending with one of the extensions .png, .jpg, .jpeg, .gif, .webp, or .svg, case-insensitive), THE Tree_View SHALL display an inline preview indicator, and WHEN the pointer remains over that value for at least 300 milliseconds, THE Tree_View SHALL render an image thumbnail preview no larger than 200 pixels in width and 200 pixels in height.
2. IF an image thumbnail preview fails to load within 5 seconds or returns a load error, THEN THE Tree_View SHALL remove the preview, render the value as an activatable link, and display an indication that the image could not be loaded.
3. WHERE a string Node value matches a hex color pattern (a "#" character followed by exactly 3, 6, or 8 hexadecimal digits, case-insensitive), THE Tree_View SHALL display a color swatch between 12 and 16 pixels square, filled with that exact color, adjacent to the value.
4. WHERE a number Node value falls within the Unix timestamp range of 0 to 4102444800 inclusive (interpreted as seconds since 1970-01-01T00:00:00Z), THE Tree_View SHALL display the corresponding human-readable date in ISO 8601 format adjacent to the value.
5. WHERE a string Node value matches a non-image URL pattern (a URL beginning with "http://" or "https://" that does not match the image URL pattern in criterion 1), THE Tree_View SHALL render the value as an activatable link, and WHEN the link is activated, THE Tree_View SHALL open the target URL in a new browser tab.
6. WHERE rich media inference is disabled by the user, THE Tree_View SHALL display all Node values as plain text with no thumbnail previews, color swatches, date annotations, or activatable links.

### Requirement 13: Format Converters

**User Story:** As a developer, I want to convert JSON to and from YAML, XML, CSV, and TOML, so that I can move data between formats.

#### Acceptance Criteria

1. WHEN a user requests conversion of valid JSON to YAML, THE Converter SHALL produce YAML text that preserves all keys, values, nesting structure, and value data types (string, number, boolean, null, object, array) of the source JSON data model.
2. WHEN a user requests conversion of valid JSON to XML, THE Converter SHALL produce XML text with a single root element wherein each JSON object key maps to a child element and each value maps to that element's text content or nested elements, preserving the source nesting structure.
3. WHEN a user requests conversion of valid JSON to CSV for an array of uniform objects, THE Converter SHALL produce CSV text with a single header row containing each unique object key exactly once and one data row per array element, with field values aligned to their corresponding header column.
4. IF a user requests conversion of JSON to CSV where the top-level value is not an array of objects, or where array elements do not share an identical set of keys, THEN THE Converter SHALL display an error message identifying the reason the input is not convertible to CSV, and SHALL NOT produce partial CSV output.
5. WHEN a user requests conversion of valid JSON to TOML, THE Converter SHALL produce TOML text that preserves all keys, values, nesting structure, and value data types of the source JSON data model.
6. WHEN a user requests conversion of valid YAML, XML, CSV, or TOML to JSON, THE Converter SHALL produce JSON text that preserves all keys, values, and nesting structure of the source data model.
7. FOR ALL valid JSON data models, converting to YAML and converting the result back to JSON SHALL yield a JSON data model that is structurally and value-wise identical to the original, ignoring insignificant key ordering (YAML round-trip property).
8. FOR ALL valid JSON data models, converting to TOML and converting the result back to JSON SHALL yield a JSON data model that is structurally and value-wise identical to the original, ignoring insignificant key ordering (TOML round-trip property).
9. WHEN any conversion completes successfully, THE Converter SHALL complete and render the output text within 2 seconds for source documents up to 5 MB in size.
10. IF a source document cannot be converted to the requested target format, THEN THE Converter SHALL display a descriptive error message identifying the reason the conversion failed and the location (line or path) of the offending content where determinable, and SHALL leave the source document unchanged.

### Requirement 14: Code Generation

**User Story:** As a developer, I want to generate typed data structures from JSON, so that I can use the payload shape directly in my code.

#### Acceptance Criteria

1. WHEN a user requests TypeScript output for valid JSON, THE Code_Generator SHALL produce syntactically valid TypeScript interface definitions in which each distinct object value maps to exactly one named definition, each property is typed by its JSON value type, and each array is typed by its element type.
2. WHEN a user requests Java output for valid JSON, THE Code_Generator SHALL produce syntactically valid Java POJO class definitions in which each distinct object value maps to exactly one named class, each field is typed by its JSON value type, and each array is typed by its element type.
3. WHEN a user requests Go output for valid JSON, THE Code_Generator SHALL produce syntactically valid Go struct definitions in which each distinct object value maps to exactly one named struct, each field is typed by its JSON value type, and each array is typed by its element type.
4. WHEN a user requests Python output for valid JSON, THE Code_Generator SHALL produce syntactically valid Python dataclass definitions in which each distinct object value maps to exactly one named dataclass, each field is typed by its JSON value type, and each array is typed by its element type.
5. WHEN a user requests Dart output for valid JSON, THE Code_Generator SHALL produce syntactically valid Dart class definitions in which each distinct object value maps to exactly one named class, each field is typed by its JSON value type, and each array is typed by its element type.
6. WHEN the Code_Generator produces output, THE Application SHALL provide a control that copies the complete generated code to the system clipboard and SHALL display a confirmation indication within 500 milliseconds when the copy completes.
7. IF the Editor content is not valid JSON WHEN a user requests code generation, THEN THE Application SHALL display the validation error state defined in Requirement 6.
8. IF the Editor content is empty or contains only whitespace WHEN a user requests code generation, THEN THE Application SHALL display the validation error state defined in Requirement 6.
9. IF copying the generated code to the system clipboard fails, THEN THE Application SHALL display an error indication that the copy did not complete and SHALL retain the displayed generated code unchanged.

### Requirement 15: Grid and Table View

**User Story:** As a developer, I want to view an array of objects as a spreadsheet, so that I can search and filter tabular data.

#### Acceptance Criteria

1. WHEN a user supplies valid JSON that is an array of objects, THE Grid_View SHALL render the array as a table with one column per distinct object key, ordered by first appearance across elements, and one row per array element preserving array order.
2. WHEN a user enters a search term of 1 or more characters, THE Grid_View SHALL display only the rows containing at least one cell whose string value contains the search term as a case-insensitive substring.
3. WHEN a user clears the search term so that it contains 0 characters, THE Grid_View SHALL display all rows.
4. WHEN a user applies a column filter, THE Grid_View SHALL display only the rows whose value in that column contains the filter term as a case-insensitive substring, while leaving any active search term applied.
5. WHEN a user sorts by a column, THE Grid_View SHALL order the rows by that column's values in ascending order, and WHEN the user activates sorting on that same column again, THE Grid_View SHALL order the rows in descending order.
6. WHERE an array element is missing a key present in other elements, THE Grid_View SHALL display an empty cell for that key in the element's row and treat that cell as a non-match for search and column filters.
7. WHEN a search or column filter matches 0 rows, THE Grid_View SHALL retain all column headers and display a message indicating that no rows match the current criteria.
8. IF the supplied JSON is not an array of objects, THEN THE Grid_View SHALL display a message stating that the grid view requires an array of objects and SHALL render no table rows.

### Requirement 16: Expression Querying

**User Story:** As a developer, I want to query JSON using JSONPath and JMESPath expressions, so that I can extract subsets of large datasets.

#### Acceptance Criteria

1. WHEN a user enters a JSONPath expression of up to 10,000 characters and selects the JSONPath mode, THE Query_Engine SHALL evaluate the expression against the current JSON document and display the matching results within 2 seconds for documents up to 50 MB.
2. WHEN a user enters a JMESPath expression of up to 10,000 characters and selects the JMESPath mode, THE Query_Engine SHALL evaluate the expression against the current JSON document and display the matching results within 2 seconds for documents up to 50 MB.
3. IF a user enters an expression that is syntactically invalid for the selected mode, THEN THE Query_Engine SHALL display an error message indicating the nature and character position of the syntax problem and SHALL leave the previously displayed results unchanged.
4. WHEN a query evaluation completes with zero matching nodes, THE Query_Engine SHALL display a no-results indicator within 2 seconds.
5. WHEN query results are displayed, THE Application SHALL provide a control that copies the complete result set to the system clipboard and SHALL display a confirmation indication when the copy succeeds.
6. IF the user triggers evaluation while the expression input is empty, THEN THE Query_Engine SHALL display a message indicating that an expression is required and SHALL leave the previously displayed results unchanged.
7. IF copying results to the system clipboard fails, THEN THE Application SHALL display an error message indicating the copy did not complete and SHALL retain the displayed results.

### Requirement 17: Large Document Performance

**User Story:** As a developer, I want to work with very large JSON files without the interface freezing, so that I can inspect production-scale payloads.

#### Acceptance Criteria

1. WHERE a document is a Large_Document, THE Application SHALL perform parsing on a Background_Worker rather than on the user-interface thread.
2. WHILE a Background_Worker is processing a document, THE Application SHALL respond to any user input action within 100 milliseconds.
3. WHILE a Background_Worker is processing a document, THE Application SHALL display a processing-progress indicator that updates at least once per second.
4. WHEN processing of a Large_Document completes, THE Application SHALL remove the processing-progress indicator and render the result in the active tool view.
5. IF processing of a document fails on a Background_Worker, THEN THE Application SHALL display an error message indicating the reason for failure, remove the processing-progress indicator, and restore the view state that was active before processing began without loss of previously loaded data.

### Requirement 18: Client-Side Privacy

**User Story:** As a privacy-conscious developer, I want all processing to happen in my browser, so that my data never leaves my machine.

#### Acceptance Criteria

1. WHEN a user loads JSON content into the Application, THE Application SHALL perform all parsing, formatting, diffing, conversion, code generation, and querying within the user's browser without issuing any network request that contains user JSON content.
2. THE Application SHALL transmit zero bytes of user JSON content to any server or endpoint external to the user's browser across all features.
3. WHEN the homepage finishes loading, THE Application SHALL display a privacy statement, visible without scrolling on a viewport of at least 1280x720 pixels, that states user data does not leave the user's machine.
4. WHILE the user's device has no active network connection, THE Application SHALL continue to perform all parsing, formatting, diffing, conversion, code generation, and querying operations on previously loaded content without error.
5. IF any feature attempts an operation that would require transmitting user JSON content to an external server, THEN THE Application SHALL block the transmission and complete the operation locally within the browser.

### Requirement 19: Keyboard-Driven Operation

**User Story:** As a power user, I want keyboard shortcuts for common actions, so that I can work quickly without the mouse.

#### Acceptance Criteria

1. WHEN a user invokes the format keyboard shortcut, THE Application SHALL perform the formatting action defined in Requirement 5 using the currently selected indentation style and SHALL complete the action within 1 second for Editor content up to 1 MB.
2. WHEN a user invokes the clear keyboard shortcut and the Editor contains one or more characters, THE Application SHALL remove all content from the Editor such that the Editor character count is 0.
3. IF a user invokes the clear keyboard shortcut while the Editor is already empty (character count is 0), THEN THE Application SHALL take no action and SHALL leave the Editor unchanged.
4. WHEN a user invokes the collapse-all keyboard shortcut, THE Application SHALL perform the collapse-all action defined in Requirement 1.
5. WHEN a user invokes a tab-switch keyboard shortcut, THE Application SHALL move keyboard focus to the single tool in the Navigation_Bar mapped to that shortcut, and SHALL provide a visible focus indicator on the focused tool.
6. WHILE the Application has focus, THE Application SHALL respond to each defined keyboard shortcut regardless of which element within the Application currently holds focus.
7. WHEN a user invokes the keyboard-shortcuts reference shortcut or activates the keyboard-shortcuts reference control, THE Application SHALL display a reference that lists every available keyboard shortcut together with its corresponding action.

### Requirement 20: URL Sharing

**User Story:** As a developer, I want to share my current JSON via a link, so that colleagues can open the same payload.

#### Acceptance Criteria

1. WHEN a user requests a Share_Link, THE Application SHALL encode the current JSON payload and active tool identifier into the URL hash fragment and copy the resulting Share_Link to the system clipboard within 2 seconds.
2. IF a user requests a Share_Link while the Editor is empty or contains invalid JSON, THEN THE Application SHALL NOT generate a Share_Link and SHALL display an error message indicating that a valid JSON payload is required.
3. IF the encoded payload of a requested Share_Link would exceed 2,000,000 characters, THEN THE Application SHALL NOT generate the Share_Link and SHALL display an error message indicating the payload is too large to share.
4. IF copying the Share_Link to the system clipboard fails, THEN THE Application SHALL display an error message indicating the copy failed and SHALL display the Share_Link so the user can copy it manually.
5. WHEN the Application loads from a URL containing an encoded payload in the hash fragment, THE Application SHALL decode the payload and populate the Editor and active tool with the decoded content within 2 seconds.
6. FOR ALL valid JSON payloads up to 2,000,000 encoded characters, decoding the encoded Share_Link payload SHALL yield a data model equivalent to the original payload, preserving object key order, array element order, value types, and numeric precision (share round-trip property).
7. IF the hash fragment of a loaded URL cannot be decoded into valid JSON, THEN THE Application SHALL display an error message indicating the shared link could not be decoded and SHALL load with an empty Editor while retaining the user's previously active tool.

### Requirement 21: Navigation and Application Shell

**User Story:** As a user, I want a single clear navigation grouping the tools, so that I can move between features easily.

#### Acceptance Criteria

1. THE Navigation_Bar SHALL present exactly four entries, one each for the Viewer, Diff Checker, Table Grid, and Converter tools, with each entry displaying a text label identifying its tool.
2. WHEN a user selects a tool entry in the Navigation_Bar, THE Application SHALL render that tool's view as the only visible tool view within 500 milliseconds of the selection.
3. WHEN a user selects a tool entry in the Navigation_Bar, THE Application SHALL set that entry as the single active entry and clear the active state from all other entries.
4. WHILE a tool is active, THE Navigation_Bar SHALL display a visible active-state indicator on that tool's entry and SHALL display no active-state indicator on any other entry.
5. WHEN a user switches from a source tool to a target tool that both operate on a single shared document, THE Application SHALL load the current Editor content into the target tool unchanged, preserving all characters, whitespace, and ordering.
6. IF a user switches to a target tool that does not operate on the shared single document, THEN THE Application SHALL retain the current Editor content in memory so that it is restored unchanged when the user returns to a tool that operates on the shared single document.

### Requirement 22: Visual Design and Responsiveness

**User Story:** As a user, I want a clean, fast, ad-free interface that works on my device, so that the tool is pleasant to use.

#### Acceptance Criteria

1. THE Application SHALL render its interface using the color, typography, spacing, and elevation design tokens defined in the project design specification, with no hardcoded values that deviate from those tokens.
2. THE Application SHALL render without third-party display advertisements, ad iframes, or ad network scripts on every view.
3. WHERE the viewport width is less than 600 pixels, THE Application SHALL present the Navigation_Bar in a collapsed mobile layout that exposes navigation actions through a single toggle control.
4. WHERE the viewport width is greater than or equal to 600 pixels and less than 960 pixels, THE Application SHALL present the Navigation_Bar in the collapsed mobile layout.
5. WHERE the viewport width is greater than or equal to 960 pixels, THE Application SHALL present the Navigation_Bar as a full horizontal layout with all top-level navigation items visible without a toggle control.
6. THE Application SHALL render all text and interactive controls at a contrast ratio of at least 4.5:1 for normal text (below 18 point or below 14 point bold) and at least 3:1 for large text (18 point and above, or 14 point bold and above) and for the visual boundaries of interactive controls, in conformance with WCAG 2.1 Level AA.
7. WHEN a user loads any Application view on a connection of 5 Mbps or greater, THE Application SHALL reach interactive state within 3 seconds.
