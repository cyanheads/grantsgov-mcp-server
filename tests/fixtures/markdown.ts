/**
 * @fileoverview CommonMark/GFM parsing for response-text parity assertions.
 * @module tests/fixtures/markdown
 */

import MarkdownIt from 'markdown-it';

/** Parses complete formatter output with GFM table support. */
export const markdownParser = new MarkdownIt('commonmark').enable('table');

/** Returns rendered inline text in document order, retaining literal code. */
export const renderedTexts = (markdown: string): string[] =>
  markdownParser
    .parse(markdown, {})
    .filter((token) => token.type === 'inline')
    .map((token) =>
      (token.children ?? [])
        .map((child) =>
          child.type === 'softbreak' || child.type === 'hardbreak' ? '\n' : child.content,
        )
        .join(''),
    );
