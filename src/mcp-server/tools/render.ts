/**
 * @fileoverview Rendering helpers for agency-authored text in `format()`. That
 * text is data, never instructions: inline slots are flattened to one line,
 * table cells cannot split their row, and multi-line fields render as
 * blockquotes so they cannot forge headings or tool-like structure.
 * `structuredContent` stays verbatim; these apply to `content[]` only.
 * @module mcp-server/tools/render
 */

/**
 * Every line terminator a renderer or tokenizer may honor: CRLF, LF, CR, and
 * the Unicode mandatory breaks (VT, FF, NEL U+0085, LS U+2028, PS U+2029).
 */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;

/** An upstream string placed inside a line: every line break flattened to one space. */
export const inline = (text: string): string => text.replace(LINE_BREAK, ' ');

/**
 * An upstream string placed in a markdown table cell: flattened, with `|`
 * escaped. A backslash run before a pipe is doubled first, so a source `\|`
 * cannot turn the added escape into an escaped backslash and split the row.
 */
export const tableCell = (text: string): string =>
  inline(text).replace(/(\\*)\|/g, (_pipe, backslashes: string) => `${backslashes.repeat(2)}\\|`);

/** A multi-line upstream field: every line prefixed with `> ` (blank lines as `>`). */
export const blockquote = (text: string): string =>
  text
    .split(LINE_BREAK)
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
