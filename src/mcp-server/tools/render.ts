/**
 * @fileoverview Rendering helpers for agency-authored text in `format()`. That
 * text is data, never instructions: inline slots are flattened to one line,
 * table cells cannot split their row, and multi-line fields render as
 * blockquotes so they cannot forge headings or tool-like structure.
 * `structuredContent` stays verbatim; these apply to `content[]` only.
 * @module mcp-server/tools/render
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * Every line terminator a renderer or tokenizer may honor: CRLF, LF, CR, and
 * the Unicode mandatory breaks (VT, FF, NEL U+0085, LS U+2028, PS U+2029).
 */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;

/** Escapes agency text before insertion into rendered markdown. */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An upstream string placed inside a line: every line break flattened to one space. */
export const inline = (text: string): string => escapeMarkdownInline(text.replace(LINE_BREAK, ' '));

/** Renders an agency URL with a literal label and a portable Markdown destination. */
export const urlLink = (url: string): string => {
  const label = escapeHtml(url)
    .replace(LINE_BREAK, ' ')
    .replace(/[\\[\]`*_~]/g, '\\$&');
  const destination = escapeHtml(url.replaceAll('\\', '\\\\'));
  return `[${label}](<${destination}>)`;
};

/** Renders a literal identifier as Markdown code, retaining its characters. */
export const codeSpan = (text: string): string => {
  const value = text.replace(LINE_BREAK, ' ');
  if (value === '') return '';
  let longest = 0;
  for (const run of value.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value));
  return `${fence}${pad ? ` ${value} ` : value}${fence}`;
};

/** GFM tables consume one backslash before each pipe, including inside code. */
export const tableCodeSpan = (text: string): string => codeSpan(text).replaceAll('|', '\\|');

/**
 * An upstream string placed in a markdown table cell, flattened and encoded
 * once so literal pipes and backslashes cannot split the row.
 */
export const tableCell = inline;

/** A multi-line upstream field: every line prefixed with `> ` (blank lines as `>`). */
export const blockquote = (text: string): string =>
  text
    .split(LINE_BREAK)
    .map((line) => (line.trim() === '' ? '>' : `> ${escapeMarkdownInline(line)}`))
    .join('\n');
