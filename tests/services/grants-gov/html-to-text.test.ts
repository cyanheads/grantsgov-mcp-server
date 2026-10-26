/**
 * @fileoverview Tests for htmlToText: agency HTML (lists, links, entities,
 * `&nbsp;` runs) and plain text with literal newlines and bare entities, which
 * must survive line for line.
 * @module tests/services/grants-gov/html-to-text.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToText } from '@/services/grants-gov/html-to-text.js';

describe('htmlToText — HTML input', () => {
  it('keeps source-spaced inline children and surrounding prose', () => {
    expect(htmlToText('Before <b>A </b><i> B</i> after')).toBe('Before A B after');
  });

  it('separates table rows and cells, including empty cells and inline children', () => {
    expect(
      htmlToText(
        'Before<table><tr><th>Phase</th><th>Maximum award</th></tr><tr><td></td><td><b>$50,000</b></td><td></td></tr><tr><td>II</td><td>$150,000</td></tr></table>After',
      ),
    ).toBe('Before\n\nPhase | Maximum award\n | $50,000 |\nII | $150,000\n\nAfter');
  });

  it('keeps source whitespace, nested tables, and malformed table text bounded', () => {
    expect(htmlToText('<table>\n<tr><td> A  <i>B</i> </td>\n<td> C</td></tr>\n</table>')).toBe(
      ' A B\n | C',
    );
    expect(
      htmlToText(
        '<table><tr><td>Outer<table><tr><td>Inner</td><td>Value</td></tr></table>tail</td><td>Next</td></tr></table>',
      ),
    ).toBe('Outer\n\nInner | Value\n\ntail | Next');
    expect(htmlToText('<table><tr><td>A<td>B<tr><td>C')).toBe('A | B\nC');
  });
  it('keeps visible text between alternate and standard comment terminators', () => {
    expect(htmlToText('A<!-- note --!>B<!-- end -->C<!-- open')).toBe('ABC<!-- open');
  });

  it('converts encoded lists and links and discards a terminal recognized tag', () => {
    expect(
      htmlToText(
        '&amp;lt;ul&amp;gt;&lt;li&gt;&lt;a href="https://example.gov"&gt;Apply&lt;/a&gt;&lt;/li&gt;&lt;/ul&gt;',
      ),
    ).toBe('- Apply (https://example.gov)');
    expect(htmlToText('Visible <span class="TextRun" d')).toBe('Visible');
    expect(htmlToText('x < y; Awards < $500; <reference>')).toBe(
      'x < y; Awards < $500; <reference>',
    );
  });
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

  it('pairs nested anchors with their own text and destination', () => {
    expect(htmlToText('<a href="outer">A<a href="inner">B</a>C</a>')).toBe('AB (inner)C (outer)');
    expect(htmlToText('<a href="outer"><a href="inner">inner</a></a>')).toBe('inner (outer)');
    expect(htmlToText('<a href="AB">A<a>B</a></a>')).toBe('AB');
  });

  it('avoids repeating a destination surrounded by source whitespace', () => {
    expect(htmlToText('<a href="https://example.gov">  https://example.gov  </a>')).toBe(
      '  https://example.gov',
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

  it('decodes entities before converting markup', () => {
    expect(htmlToText('&lt;b&gt;not bold&lt;/b&gt;')).toBe('not bold');
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
  it.each([
    ['openers', '<a', false],
    ['nested openers', '<a', true],
    ['comments', '<!--', false],
    ['anchors', '<a href="u">', true],
    ['spaced anchors', '<a href="u"> ', true],
    ['entities', '&amp;amp;', false],
    ['overlapping names', '&NotEqualTilde', false],
    ['table cells', '<table><tr><td>x<td>', false],
    ['nested tables', '<table><tr><td>', false],
    ['terminal line break', '§1 x', false],
    ['line breaks throughout', '  \r\n', false],
  ] as const)('text CPU scaling: %s', { timeout: 30_000 }, (_name, token, closed) => {
    for (const breaks of [false, true]) {
      const make = (size: number) => {
        const part = breaks ? `${token}\n` : token;
        const count = Math.ceil(size / part.length);
        return `${part.repeat(count)}${closed ? '</a>'.repeat(count) : ''}\n${token === '§1 x' ? 'y' : ''}`;
      };
      const measure = (input: string) => {
        const started = process.threadCpuUsage();
        let elapsed = 0;
        let count = 0;
        let result = '';
        do {
          result = htmlToText(input);
          count++;
          const cpu = process.threadCpuUsage(started);
          elapsed = cpu.user + cpu.system;
          expect(elapsed).toBeLessThan(1_000_000);
        } while (elapsed < 20_000 && count < 16384);
        expect(elapsed).toBeGreaterThan(0);
        expect(result.length).toBeLessThanOrEqual(input.length * 2);
        return elapsed / count;
      };
      measure(make(5_000));
      const baseline = measure(make(5_000));
      for (let size = 10_000; size <= 320_000; size *= 2) {
        const elapsed = measure(make(size));
        expect(elapsed).toBeLessThan(1_000_000);
        expect(elapsed / baseline).toBeLessThan(256);
      }
    }
  });

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
    expect(htmlToText('<a <b>bold</b>')).toBe('bold');
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
    const started = process.threadCpuUsage();
    const text = htmlToText(input);
    const cpu = process.threadCpuUsage(started);
    expect(cpu.user + cpu.system).toBeLessThan(250_000);
    expect(text.length).toBeLessThanOrEqual(input.length * 2);
  });
});
