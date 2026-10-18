/**
 * @fileoverview Converts agency-authored Grants.gov text to plain text. Fields
 * arrive either as HTML or as plain text with real line structure and bare
 * entities, so source newlines are always kept and tags only add breaks.
 * @module services/grants-gov/html-to-text
 */

import { decodeEntities } from './normalize.js';

/**
 * Each candidate stops at the next angle bracket or end of input. The boundary
 * after the name preserves comparisons; the vocabulary preserves non-HTML text.
 */
const TAG = /<(\/?)([a-z][a-z0-9]*)(?=[\s/>]|$)([^<>]*)(>|(?=<)|$)/gi;

const HTML_ELEMENTS = new Set(
  'a abbr acronym address applet area article aside audio b base basefont bdi bdo big blockquote body br button canvas caption center cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em embed fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark marquee menu meta meter nav noframes noscript object ol optgroup option output p param picture plaintext pre progress q rb rp rt rtc ruby s samp script search section select slot small source span strike strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track tt u ul var video wbr xmp'.split(
    ' ',
  ),
);

/**
 * Removes every span from an `open` match through the next `close` match, left
 * to right. An `open` with no `close` after it ends the scan, since no later one
 * can have a `close` either; its text is kept. Both patterns must be global so
 * `lastIndex` positions them.
 */
function removeSpans(source: string, open: RegExp, close: RegExp): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    open.lastIndex = cursor;
    const start = open.exec(source);
    if (!start) break;
    close.lastIndex = start.index + start[0].length;
    const end = close.exec(source);
    if (!end) break;
    out += source.slice(cursor, start.index);
    cursor = end.index + end[0].length;
  }
  return out + source.slice(cursor);
}

/** Removes comments, then `script` and `style` elements with their content. */
function stripHidden(source: string): string {
  const withoutComments = removeSpans(source, /<!--/g, /--!?>/g);
  const withoutScripts = removeSpans(withoutComments, /<script\b[^<>]*>/gi, /<\/script\s*>/gi);
  return removeSpans(withoutScripts, /<style\b[^<>]*>/gi, /<\/style\s*>/gi);
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Nesting levels a list item's indent reflects; deeper lists indent no further, so output stays linear in input. */
const MAX_LIST_DEPTH = 6;

interface ListFrame {
  counter: number;
  ordered: boolean;
}

/**
 * Normalizes HTML or plain text for output.
 *
 * - `p`/`div` → paragraph breaks, `br` → line break, `li` → `- ` bullets
 *   (`1. ` inside `ol`), `a href` → `text (url)`, other recognized tags stripped with
 *   its text kept (`script`/`style` content dropped).
 * - At most two entity layers decoded before the forward markup scan.
 * - `&nbsp;` and interior whitespace runs collapse to one space; leading
 *   indentation is kept; each line is right-trimmed; 3+ newlines collapse to one
 *   blank line.
 */
export function htmlToText(input: string): string {
  const lists: ListFrame[] = [];
  const links: { url: string | undefined; start: number }[] = [];
  let waitingForText: { start: number }[] = [];
  let textEnd = 0;
  let out = '';
  let cursor = 0;

  /** Resolve each link's trimmed start once, without rescanning nested link text. */
  const append = (chunk: string) => {
    const first = chunk.search(/\S/);
    if (first !== -1) {
      for (const link of waitingForText) link.start = out.length + first;
      waitingForText = [];
      textEnd = out.length + chunk.trimEnd().length;
    }
    out += chunk;
  };

  const source = stripHidden(decodeEntities(input).replace(/\r\n?/g, '\n'));

  for (const match of source.matchAll(TAG)) {
    const name = (match[2] ?? '').toLowerCase();
    if (!HTML_ELEMENTS.has(name)) continue;
    append(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const closing = match[1] === '/';

    switch (name) {
      case 'br':
        append('\n');
        break;
      case 'p':
      case 'div':
        append('\n\n');
        break;
      case 'ul':
      case 'ol':
        if (closing) lists.pop();
        else lists.push({ ordered: name === 'ol', counter: 0 });
        append('\n');
        break;
      case 'li': {
        if (closing) break;
        const frame = lists.at(-1);
        const indent = '  '.repeat(Math.max(0, Math.min(lists.length, MAX_LIST_DEPTH) - 1));
        const marker = frame?.ordered ? `${++frame.counter}. ` : '- ';
        append(`\n${indent}${marker}`);
        break;
      }
      case 'a': {
        if (!closing) {
          const href = HREF.exec(match[3] ?? '');
          const link = { url: (href?.[1] ?? href?.[2] ?? href?.[3])?.trim(), start: out.length };
          links.push(link);
          waitingForText.push(link);
          break;
        }
        const link = links.pop();
        const url = link?.url;
        if (
          url &&
          (textEnd - link.start !== url.length || out.slice(link.start, textEnd) !== url)
        ) {
          append(` (${url})`);
        }
        break;
      }
      default:
        break;
    }
  }
  append(source.slice(cursor));

  return out
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
