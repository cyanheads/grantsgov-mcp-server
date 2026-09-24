/**
 * @fileoverview Tests for the pure Grants.gov normalizers: US Eastern "today",
 * date arithmetic, the four upstream date shapes, money and counts, close-date
 * kind, and entity decoding.
 * @module tests/services/grants-gov/normalize.test
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  closeDateKind,
  daysBetween,
  decodeEntities,
  parseCount,
  parseLongDate,
  parseMoney,
  parseSlashDate,
  parseStrDate,
  todayET,
} from '@/services/grants-gov/normalize.js';

describe('todayET', () => {
  it('reports the Eastern calendar date, not the UTC one (EDT, UTC-4)', () => {
    expect(todayET(new Date('2026-09-24T03:30:00Z'))).toBe('2026-09-23');
    expect(todayET(new Date('2026-09-24T04:30:00Z'))).toBe('2026-09-24');
  });

  it('follows standard time in winter (EST, UTC-5)', () => {
    expect(todayET(new Date('2026-01-15T04:30:00Z'))).toBe('2026-01-14');
    expect(todayET(new Date('2026-01-15T05:30:00Z'))).toBe('2026-01-15');
  });

  it('defaults to now and returns YYYY-MM-DD', () => {
    expect(todayET()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('addDays / daysBetween', () => {
  it.each([
    ['2026-12-31', 1, '2027-01-01'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2026-03-08', 1, '2026-03-09'],
    ['2026-11-01', 1, '2026-11-02'],
    ['2026-09-24', -30, '2026-08-25'],
    ['2026-09-24', 0, '2026-09-24'],
  ])('addDays(%s, %i) = %s, independent of DST', (from, days, expected) => {
    expect(addDays(from, days)).toBe(expected);
  });

  it('counts whole days, negative when the target is earlier', () => {
    expect(daysBetween('2026-09-24', '2026-10-19')).toBe(25);
    expect(daysBetween('2026-09-24', '2026-09-24')).toBe(0);
    expect(daysBetween('2026-09-24', '2026-09-20')).toBe(-4);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });
});

describe('parseSlashDate', () => {
  it.each([
    ['09/24/2026', '2026-09-24'],
    ['1/2/2026', '2026-01-02'],
    [' 01/01/2099 ', '2099-01-01'],
    ['08/17/2076', '2076-08-17'],
  ])('parses %j', (raw, expected) => {
    expect(parseSlashDate(raw)).toBe(expected);
  });

  it.each([[''], ['02/30/2026'], ['2026-09-24'], ['13/01/2026'], [null], [undefined], [20260924]])(
    'returns undefined for blank, malformed, impossible, or non-string %j',
    (raw) => {
      expect(parseSlashDate(raw)).toBeUndefined();
    },
  );
});

describe('parseStrDate', () => {
  it('drops the midnight time artifact from a …Str date', () => {
    expect(parseStrDate('2026-10-19-00-00-00')).toBe('2026-10-19');
  });

  it('accepts an already-ISO date and an ISO timestamp', () => {
    expect(parseStrDate('2026-10-19')).toBe('2026-10-19');
    expect(parseStrDate('2026-10-19T14:07:27Z')).toBe('2026-10-19');
  });

  it.each([[''], ['undefined'], ['2026-13-01-00-00-00'], ['2026-02-30'], ['Oct 19, 2026'], [null]])(
    'returns undefined for %j',
    (raw) => {
      expect(parseStrDate(raw)).toBeUndefined();
    },
  );
});

describe('parseLongDate', () => {
  it.each([
    ['Oct 19, 2026 12:00:00 AM EDT', '2026-10-19'],
    ['Sep 18, 2026 02:07:27 PM EDT', '2026-09-18'],
    ['Mar 20, 2015', '2015-03-20'],
    ['Sept 5, 2026', '2026-09-05'],
    ['dec 1, 2026', '2026-12-01'],
  ])('parses %j', (raw, expected) => {
    expect(parseLongDate(raw)).toBe(expected);
  });

  it.each([['Feb 30, 2026'], ['Foo 1, 2026'], ['2026-10-19'], [''], [null]])(
    'returns undefined for %j',
    (raw) => {
      expect(parseLongDate(raw)).toBeUndefined();
    },
  );
});

describe('parseMoney', () => {
  it.each([
    ['10116100', 10116100],
    ['1,500,000', 1_500_000],
    ['$250000.00', 250_000],
    ['  42 ', 42],
    [650000, 650000],
  ])('parses %j', (raw, expected) => {
    expect(parseMoney(raw)).toBe(expected);
  });

  it('keeps "0" as 0 (DOD lists 0 alongside a real funding total)', () => {
    expect(parseMoney('0')).toBe(0);
    expect(parseMoney(0)).toBe(0);
  });

  it.each([
    ['none'],
    [''],
    [null],
    [undefined],
    ['undefined'],
    ['-5'],
    [-5],
    [Number.NaN],
    ['1e6'],
  ])('returns undefined for %j', (raw) => {
    expect(parseMoney(raw)).toBeUndefined();
  });
});

describe('parseCount', () => {
  it.each([
    ['63', 63],
    ['1,200', 1200],
    [' 7 ', 7],
    [5, 5],
    ['0', 0],
  ])('parses %j', (raw, expected) => {
    expect(parseCount(raw)).toBe(expected);
  });

  it.each([['6.5'], [5.5], [-1], [null], [undefined], ['none'], ['']])(
    'returns undefined for %j',
    (raw) => {
      expect(parseCount(raw)).toBeUndefined();
    },
  );
});

describe('closeDateKind', () => {
  const today = '2026-09-24';

  it('is none_listed when no close date is listed', () => {
    expect(closeDateKind(undefined, today)).toBe('none_listed');
    expect(closeDateKind('', today)).toBe('none_listed');
  });

  it('marks the 2099 sentinel and the NSF 2076 "accepted anytime" date as placeholders', () => {
    expect(closeDateKind('2099-01-01', today)).toBe('placeholder');
    expect(closeDateKind('2076-08-17', today)).toBe('placeholder');
  });

  it('keeps long-running DOD BAAs (2034–2044) fixed', () => {
    expect(closeDateKind('2034-06-30', today)).toBe('fixed');
    expect(closeDateKind('2044-12-31', today)).toBe('fixed');
  });

  it('draws the placeholder line at 25 years past the current ET year', () => {
    expect(closeDateKind('2050-12-31', today)).toBe('fixed');
    expect(closeDateKind('2051-01-01', today)).toBe('placeholder');
  });

  it('treats a past date as fixed', () => {
    expect(closeDateKind('2026-09-01', today)).toBe('fixed');
  });
});

describe('decodeEntities', () => {
  it('decodes the named set Grants.gov emits', () => {
    expect(decodeEntities('Alzheimer&rsquo;s &ldquo;Award&rdquo; &ndash; &mdash; &hellip;')).toBe(
      'Alzheimer’s “Award” – — …',
    );
    expect(decodeEntities('E&amp;T &lt;b&gt; &quot;x&quot; &apos;y&apos; &lsquo;z&rsquo;')).toBe(
      'E&T <b> "x" \'y\' ‘z’',
    );
    expect(decodeEntities('a&nbsp;b')).toBe('a\xa0b');
  });

  it('decodes named entities case-insensitively', () => {
    expect(decodeEntities('&AMP; &Rsquo;')).toBe('& ’');
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeEntities('&#8217; &#x2019; &#X2019; &#39;')).toBe("’ ’ ’ '");
  });

  it('decodes a double-encoded entity once', () => {
    expect(decodeEntities('&amp;rsquo;')).toBe('&rsquo;');
  });

  it('leaves unknown named entities and invalid code points as written', () => {
    expect(decodeEntities('&bogus; &#0; &#xD800; &#1114112;')).toBe(
      '&bogus; &#0; &#xD800; &#1114112;',
    );
  });

  it('leaves a bare ampersand alone', () => {
    expect(decodeEntities('R&D and A & B')).toBe('R&D and A & B');
  });
});
