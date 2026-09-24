/**
 * @fileoverview Tests for htmlToText: agency HTML (lists, links, entities,
 * `&nbsp;` runs) and plain text with literal newlines and bare entities, which
 * must survive line for line.
 * @module tests/services/grants-gov/html-to-text.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToText } from '@/services/grants-gov/html-to-text.js';

describe('htmlToText — HTML input', () => {
  it('turns p and div into paragraph breaks', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
    expect(htmlToText('<div>One</div><div>Two</div>')).toBe('One\n\nTwo');
    expect(htmlToText('<P>Upper</P><P>Case</P>')).toBe('Upper\n\nCase');
  });

  it('turns br into a line break, in every spelling', () => {
    expect(htmlToText('Line 1<br>Line 2<br/>Line 3<BR />Line 4')).toBe(
      'Line 1\nLine 2\nLine 3\nLine 4',
    );
  });

  it('renders ul items as - bullets and ol items as numbers', () => {
    expect(htmlToText('<ul><li>Tribes</li><li>Nonprofits</li></ul>')).toBe(
      '- Tribes\n- Nonprofits',
    );
    expect(htmlToText('<ol><li>Apply</li><li>Wait</li></ol>')).toBe('1. Apply\n2. Wait');
  });

  it('indents nested list items', () => {
    const lines = htmlToText('<ul><li>States<ul><li>Territories</li></ul></li></ul>').split('\n');
    expect(lines).toContain('- States');
    expect(lines).toContain('  - Territories');
  });

  it('restarts numbering per ordered list', () => {
    expect(htmlToText('<ol><li>a</li><li>b</li></ol><ol><li>c</li></ol>')).toBe(
      '1. a\n2. b\n\n1. c',
    );
  });

  it('keeps link text and appends the href', () => {
    expect(htmlToText('See the <a href="https://www.hrsa.gov/nofo">NOFO</a>.')).toBe(
      'See the NOFO (https://www.hrsa.gov/nofo).',
    );
    expect(htmlToText("<a href='https://example.gov/a'>single</a>")).toBe(
      'single (https://example.gov/a)',
    );
    expect(htmlToText('<a href=https://example.gov/b>bare</a>')).toBe(
      'bare (https://example.gov/b)',
    );
  });

  it('does not repeat a URL that is already the link text', () => {
    expect(htmlToText('<a href="https://www.grants.gov">https://www.grants.gov</a>')).toBe(
      'https://www.grants.gov',
    );
  });

  it('keeps the text of an anchor with no href', () => {
    expect(htmlToText('<a name="top">Top</a> of page')).toBe('Top of page');
  });

  it('strips inline formatting tags and keeps their text', () => {
    expect(
      htmlToText(
        '<strong>Due</strong> <em>soon</em>, <b>see</b> <i>below</i><sup>1</sup> <span>ok</span>',
      ),
    ).toBe('Due soon, see below1 ok');
  });

  it('drops script and style content and comments', () => {
    expect(
      htmlToText('<script>alert(1)</script>Text<style>p{color:red}</style><!-- note -->.'),
    ).toBe('Text.');
  });

  it('decodes entities after tags are removed, so encoded markup stays text', () => {
    expect(htmlToText('&lt;b&gt;not bold&lt;/b&gt;')).toBe('<b>not bold</b>');
  });

  it('leaves a literal < that does not start a tag', () => {
    expect(htmlToText('Awards < $500,000')).toBe('Awards < $500,000');
  });

  it('collapses &nbsp; and interior whitespace runs to one space', () => {
    expect(htmlToText('Award&nbsp;&nbsp;&nbsp;ceiling:   $1M')).toBe('Award ceiling: $1M');
  });
});

describe('htmlToText — plain-text input', () => {
  it('keeps literal newline structure line for line', () => {
    const text = 'Eligible applicants:\n1. Nonprofits\n2. Tribes\n\nSee Section C.';
    expect(htmlToText(text)).toBe(text);
  });

  it('decodes bare entities in plain text', () => {
    expect(htmlToText('&ldquo;Quoted&rdquo; text')).toBe('“Quoted” text');
  });

  it('normalizes CRLF and CR to LF', () => {
    expect(htmlToText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('collapses 3+ newlines to one blank line and trims the ends', () => {
    expect(htmlToText('\n\nFirst\n\n\n\n\nSecond\n\n\n')).toBe('First\n\nSecond');
  });

  it('right-trims each line and keeps leading indentation', () => {
    expect(htmlToText('Header   \n    indented item  ')).toBe('Header\n    indented item');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<p></p>')).toBe('');
  });
});

describe('htmlToText — malformed and hostile markup', () => {
  it('keeps the text of an unterminated comment, script, or style', () => {
    expect(htmlToText('Before <!-- never closed')).toBe('Before <!-- never closed');
    expect(htmlToText('<!-- a -->Kept<!-- open')).toBe('Kept<!-- open');
    expect(htmlToText('<script>x')).toBe('x');
    expect(htmlToText('<style>p{}</style>Text<style>q')).toBe('Textq');
  });

  it('drops each closed script or style element, in any case', () => {
    expect(htmlToText('A<SCRIPT type="x">1</SCRIPT >B<script>2</script>C')).toBe('ABC');
  });

  it('strips a tag that follows an unclosed one', () => {
    expect(htmlToText('<a <b>bold</b>')).toBe('<a bold');
  });

  it('caps list indentation, so deep nesting cannot multiply the output', () => {
    const depth = 2_000;
    const text = htmlToText(`${'<ul>'.repeat(depth)}<li>deep</li>${'</ul>'.repeat(depth)}`);
    expect(text).toBe(`${'  '.repeat(5)}- deep`);
  });

  it.each([
    ['unclosed tags', '<a'.repeat(50_000)],
    ['unclosed tags with attributes', '<a href=x '.repeat(10_000)],
    ['unterminated comments', '<!--'.repeat(25_000)],
    ['unclosed scripts', '<script>'.repeat(12_500)],
    ['unclosed styles after a closed one', `<style></style>${'<style>'.repeat(12_500)}`],
    ['nested lists', `${'<ul>'.repeat(10_000)}${'<li>x'.repeat(10_000)}`],
  ])('converts 100 KB of %s in linear time', (_name, input) => {
    const started = performance.now();
    const text = htmlToText(input);
    expect(performance.now() - started).toBeLessThan(250);
    expect(text.length).toBeLessThanOrEqual(input.length * 2);
  });
});
