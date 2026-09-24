/**
 * @fileoverview Tests for the reference snapshot (vocabulary, counts, agency
 * tree) and agency filter encoding: space-bearing codes, the `DOT-FTA - TPM`
 * non-hyphen child, non-code prefixes, and never `CODE*`.
 * @module tests/services/grants-gov/reference.test
 */

import { describe, expect, it } from 'vitest';
import {
  buildReferenceSnapshot,
  encodeAgencyFilter,
  resolveAgencyScope,
} from '@/services/grants-gov/reference.js';
import { FACETS_ALL, FACETS_OPEN } from '../../fixtures/grants-gov.js';

const FETCHED_AT = '2026-09-24T13:00:00.000Z';
const snapshot = buildReferenceSnapshot(FACETS_ALL, FACETS_OPEN, FETCHED_AT);

const node = (code: string) => {
  const found = snapshot.agencies.get(code);
  if (!found) throw new Error(`No snapshot node for ${code}`);
  return found;
};

describe('buildReferenceSnapshot — agency tree', () => {
  it('lists top-level agencies sorted, and records the fetch time', () => {
    expect(snapshot.topLevelAgencies).toEqual(['DOC', 'DOT', 'HHS', 'NSF', 'USDA']);
    expect(snapshot.fetchedAt).toBe(FETCHED_AT);
  });

  it('holds every unique code once, with the self sub-entry folded into its parent row', () => {
    expect(snapshot.agencies.size).toBe(5 + 2 + 7 + 9 + 3);
    const doc = node('DOC');
    expect(doc.totalCount).toBe(1419);
    expect(doc.label).toBe('Department of Commerce');
    expect(doc.parentCode).toBeUndefined();
    expect(doc.children).toEqual(['DOC-EDA', 'DOC-NOAA']);
  });

  it('derives parents from hyphen prefixes, at any depth', () => {
    expect(node('DOT-FAA').parentCode).toBe('DOT');
    expect(node('DOT-FAA-AIP').parentCode).toBe('DOT-FAA');
    expect(node('DOT-FAA-FAA COE').parentCode).toBe('DOT-FAA');
    expect(node('DOT-FAA-FAA COE-AJFE').parentCode).toBe('DOT-FAA-FAA COE');
    expect(node('DOT-FAA-FAA COE-FAA JAMS').parentCode).toBe('DOT-FAA-FAA COE');
    expect(node('HHS-CDC-NCCDPHP').parentCode).toBe('HHS-CDC');
  });

  it('parents a code joined by " - " (DOT-FTA - TPM) under DOT-FTA', () => {
    expect(node('DOT-FTA - TPM').parentCode).toBe('DOT-FTA');
    expect(node('DOT-FTA').children).toEqual(['DOT-FTA - TPM']);
  });

  it('never parents a code under a non-hyphen prefix (USDA-FSA is not under USDA-FS)', () => {
    expect(node('USDA-FSA').parentCode).toBe('USDA');
    expect(node('USDA-FSIS').parentCode).toBe('USDA');
    expect(node('USDA-FS').descendants).toEqual([]);
  });

  it('falls back to the top-level agency when the hyphen prefix is not a code (HHS-OS)', () => {
    expect(node('HHS-OS-ASPE').parentCode).toBe('HHS');
    expect(snapshot.agencies.has('HHS-OS')).toBe(false);
  });

  it('keeps direct children and the full descendant list separately', () => {
    const faa = node('DOT-FAA');
    expect(faa.children).toEqual(['DOT-FAA-AIP', 'DOT-FAA-FAA ARG', 'DOT-FAA-FAA COE']);
    expect(faa.descendants).toEqual([
      'DOT-FAA-AIP',
      'DOT-FAA-FAA ARG',
      'DOT-FAA-FAA COE',
      'DOT-FAA-FAA COE-AJFE',
      'DOT-FAA-FAA COE-FAA JAMS',
      'DOT-FAA-FAA COE-GACOE',
    ]);
    expect(node('NSF').children).toEqual([]);
    expect(node('NSF').descendants).toEqual([]);
  });

  it('trims labels (some agency names carry a trailing space)', () => {
    expect(node('DOT-FAA').label).toBe('DOT Federal Aviation Administration');
  });

  it('reads open counts from the default-scope facets, 0 when absent there', () => {
    expect(node('HHS')).toMatchObject({ openCount: 940, totalCount: 23899 });
    expect(node('HHS-NIH11')).toMatchObject({ openCount: 697, totalCount: 12853 });
    expect(node('DOT')).toMatchObject({ openCount: 0, totalCount: 1492 });
  });
});

describe('buildReferenceSnapshot — flat vocabularies', () => {
  it('sorts eligibilities by code with open and total counts', () => {
    expect(snapshot.eligibilities.map((e) => e.code)).toEqual(['07', '12', '25', '99']);
    expect(snapshot.eligibilities.find((e) => e.code === '12')).toMatchObject({
      openCount: 883,
      totalCount: 29418,
    });
    expect(snapshot.eligibilities.find((e) => e.code === '07')).toMatchObject({ openCount: 0 });
  });

  it('builds funding categories and instruments', () => {
    expect(snapshot.fundingCategories.map((e) => e.code)).toEqual(['AG', 'ED', 'HL', 'ST']);
    expect(snapshot.fundingInstruments.map((e) => e.code)).toEqual(['CA', 'G', 'O', 'PC']);
  });

  it('lowercases status keys', () => {
    expect(snapshot.statusCounts).toEqual({
      forecasted: 591,
      posted: 940,
      closed: 8700,
      archived: 73220,
    });
  });

  it('skips codeless entries, de-duplicates codes, trims values, and falls back to the code as label', () => {
    const built = buildReferenceSnapshot(
      {
        eligibilities: [
          { value: ' 12 ', label: ' Nonprofits ', count: 5 },
          { value: '12', label: 'Duplicate', count: 99 },
          { value: '', label: 'No code', count: 1 },
          { value: null, label: 'Null code', count: 1 },
          { value: '99', label: null, count: null },
        ],
        agencies: [
          { value: '', label: 'Blank agency' },
          { value: 'NSF', label: null },
        ],
      },
      {},
      FETCHED_AT,
    );
    expect(built.eligibilities).toEqual([
      { code: '12', label: 'Nonprofits', openCount: 0, totalCount: 5 },
      { code: '99', label: '99', openCount: 0, totalCount: 0 },
    ]);
    expect(built.topLevelAgencies).toEqual(['NSF']);
    expect(built.agencies.get('NSF')?.label).toBe('NSF');
  });

  it('tolerates missing facet blocks', () => {
    const built = buildReferenceSnapshot({}, {}, FETCHED_AT);
    expect(built.agencies.size).toBe(0);
    expect(built.eligibilities).toEqual([]);
    expect(built.statusCounts).toEqual({});
  });
});

describe('resolveAgencyScope', () => {
  it('resolves a snapshot code to its node', () => {
    expect(resolveAgencyScope(snapshot, 'HHS-NIH11')).toMatchObject({
      kind: 'code',
      node: { code: 'HHS-NIH11' },
    });
  });

  it('resolves a hyphen-delimited non-code prefix to the codes under it', () => {
    expect(resolveAgencyScope(snapshot, 'HHS-OS')).toEqual({
      kind: 'prefix',
      prefix: 'HHS-OS',
      codes: ['HHS-OS-ASPE', 'HHS-OS-ASPR', 'HHS-OS-OCIIO', 'HHS-OS-ONC'],
    });
  });

  it.each([['XYZ'], ['HHS-O'], ['DOT-FAA-FAA'], ['USDA-F'], ['hhs']])(
    'returns undefined for %j (neither a code nor a hyphen prefix of one)',
    (value) => {
      expect(resolveAgencyScope(snapshot, value)).toBeUndefined();
    },
  );
});

describe('encodeAgencyFilter', () => {
  it('sends a leaf code bare', () => {
    expect(encodeAgencyFilter(['NSF'], snapshot)).toBe('NSF');
    expect(encodeAgencyFilter(['HHS-NIH11'], snapshot)).toBe('HHS-NIH11');
  });

  it('expands a space-free parent to CODE|CODE-*, the exact subtree', () => {
    expect(encodeAgencyFilter(['HHS'], snapshot)).toBe('HHS|HHS-*');
    expect(encodeAgencyFilter(['HHS-CDC'], snapshot)).toBe('HHS-CDC|HHS-CDC-*');
  });

  it('never sends CODE* for a code that prefixes unrelated codes without a hyphen', () => {
    const encoded = encodeAgencyFilter(['USDA-FS'], snapshot);
    expect(encoded).toBe('USDA-FS');
    expect(encoded).not.toContain('USDA-FS*');
  });

  it('appends descendants CODE-* cannot match, quoted (DOT-FTA - TPM under DOT-FTA)', () => {
    expect(encodeAgencyFilter(['DOT-FTA'], snapshot)).toBe('DOT-FTA|DOT-FTA-*|"DOT-FTA - TPM"');
  });

  it('quotes a space-bearing code and lists its descendants explicitly, quoted', () => {
    expect(encodeAgencyFilter(['DOT-FAA-FAA COE'], snapshot)).toBe(
      [
        '"DOT-FAA-FAA COE"',
        '"DOT-FAA-FAA COE-AJFE"',
        '"DOT-FAA-FAA COE-FAA JAMS"',
        '"DOT-FAA-FAA COE-GACOE"',
      ].join('|'),
    );
  });

  it('quotes a space-bearing leaf code on its own', () => {
    expect(encodeAgencyFilter(['DOT-FTA - TPM'], snapshot)).toBe('"DOT-FTA - TPM"');
  });

  it('sends a non-code prefix as its subtree only, with no self term', () => {
    expect(encodeAgencyFilter(['HHS-OS'], snapshot)).toBe('HHS-OS-*');
  });

  it('never places a wildcard inside quotes', () => {
    for (const code of snapshot.agencies.keys()) {
      expect(encodeAgencyFilter([code], snapshot)).not.toMatch(/"[^"]*\*[^"]*"/);
    }
  });

  it('pipe-joins several values and de-duplicates the parts', () => {
    expect(encodeAgencyFilter(['NSF', 'HHS', 'HHS'], snapshot)).toBe('NSF|HHS|HHS-*');
    expect(encodeAgencyFilter(['DOT-FTA', 'DOT-FTA - TPM'], snapshot)).toBe(
      'DOT-FTA|DOT-FTA-*|"DOT-FTA - TPM"',
    );
  });

  it('throws on a value that was not validated against the snapshot', () => {
    expect(() => encodeAgencyFilter(['XYZ'], snapshot)).toThrow(/not a validated agency value/);
  });
});
