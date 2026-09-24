/**
 * @fileoverview Rendering helpers for agency-authored text in `format()`. That
 * text is data, never instructions: inline slots are flattened to one line,
 * table cells cannot split their row, and multi-line fields render as
 * blockquotes so they cannot forge headings or tool-like structure.
 * `structuredContent` stays verbatim; these apply to `content[]` only.
 * @module mcp-server/tools/render
 */

const LINE_BREAK = /\r\n|\r|\n/g;

/** An upstream string placed inside a line: CR/LF/CRLF flattened to one space. */
export const inline = (text: string): string => text.replace(LINE_BREAK, ' ');

/** An upstream string placed in a markdown table cell: flattened, with `|` escaped. */
export const tableCell = (text: string): string => inline(text).replace(/\|/g, '\\|');

/** A multi-line upstream field: every line prefixed with `> ` (blank lines as `>`). */
export const blockquote = (text: string): string =>
  text
    .split(LINE_BREAK)
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
