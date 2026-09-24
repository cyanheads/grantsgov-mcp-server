/**
 * @fileoverview Converts agency-authored Grants.gov text to plain text. Fields
 * arrive either as HTML or as plain text with real line structure and bare
 * entities, so source newlines are always kept and tags only add breaks.
 * @module services/grants-gov/html-to-text
 */

import { decodeEntities } from './normalize.js';

/** Elements whose content is dropped along with the tags. */
const DROPPED_CONTENT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const COMMENT = /<!--[\s\S]*?-->/g;

/** Any start or end tag. The name must start with a letter, so `< $500` stays text. */
const TAG = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi;

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

interface ListFrame {
  counter: number;
  ordered: boolean;
}

/**
 * Normalizes HTML or plain text for output.
 *
 * - `p`/`div` → paragraph breaks, `br` → line break, `li` → `- ` bullets
 *   (`1. ` inside `ol`), `a href` → `text (url)`, every other tag stripped with
 *   its text kept (`script`/`style` content dropped).
 * - Entities decoded after tags are removed, so encoded markup stays text.
 * - `&nbsp;` and interior whitespace runs collapse to one space; leading
 *   indentation is kept; each line is right-trimmed; 3+ newlines collapse to one
 *   blank line.
 */
export function htmlToText(input: string): string {
  const lists: ListFrame[] = [];
  const links: (string | undefined)[] = [];
  let linkTextStart = 0;
  let out = '';
  let cursor = 0;

  const source = input.replace(/\r\n?/g, '\n').replace(COMMENT, '').replace(DROPPED_CONTENT, '');

  for (const match of source.matchAll(TAG)) {
    out += source.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = (match[2] ?? '').toLowerCase();

    switch (name) {
      case 'br':
        out += '\n';
        break;
      case 'p':
      case 'div':
        out += '\n\n';
        break;
      case 'ul':
      case 'ol':
        if (closing) lists.pop();
        else lists.push({ ordered: name === 'ol', counter: 0 });
        out += '\n';
        break;
      case 'li': {
        if (closing) break;
        const frame = lists.at(-1);
        const indent = '  '.repeat(Math.max(0, lists.length - 1));
        const marker = frame?.ordered ? `${++frame.counter}. ` : '- ';
        out += `\n${indent}${marker}`;
        break;
      }
      case 'a': {
        if (!closing) {
          const href = HREF.exec(match[3] ?? '');
          links.push(href?.[1] ?? href?.[2] ?? href?.[3]);
          linkTextStart = out.length;
          break;
        }
        const url = links.pop()?.trim();
        if (url && decodeEntities(out.slice(linkTextStart)).trim() !== decodeEntities(url)) {
          out += ` (${url})`;
        }
        break;
      }
      default:
        break;
    }
  }
  out += source.slice(cursor);

  return decodeEntities(out)
    .split('\n')
    .map((line) =>
      line
        .replace(/\xa0/g, ' ')
        .replace(/(\S)[ \t]{2,}/g, '$1 ')
        .trimEnd(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}
