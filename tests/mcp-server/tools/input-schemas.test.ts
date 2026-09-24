/**
 * @fileoverview Tests for the shared input conventions: blank strings and
 * emptied lists read as unset, and agency-code normalization runs ahead of the
 * pattern check.
 * @module tests/mcp-server/tools/input-schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  AGENCY_CODE,
  blankToUndefined,
  normalizeAgencyCode,
  optionalList,
  optionalText,
} from '@/mcp-server/tools/input-schemas.js';

describe('blankToUndefined', () => {
  it('reads blank and whitespace-only strings as unset', () => {
    expect(blankToUndefined('')).toBeUndefined();
    expect(blankToUndefined('   ')).toBeUndefined();
    expect(blankToUndefined('\t\n')).toBeUndefined();
  });

  it('trims other strings and passes non-strings through', () => {
    expect(blankToUndefined('  HHS ')).toBe('HHS');
    expect(blankToUndefined(5)).toBe(5);
    expect(blankToUndefined(null)).toBeNull();
    expect(blankToUndefined(undefined)).toBeUndefined();
  });
});

describe('optionalText', () => {
  const schema = z.object({ q: optionalText(z.string().max(5)).describe('q') });

  it('reads a form client’s blank value as unset', () => {
    expect(schema.parse({ q: '' })).toEqual({ q: undefined });
    expect(schema.parse({ q: '   ' })).toEqual({ q: undefined });
    expect(schema.parse({})).toEqual({});
  });

  it('trims before the inner schema validates', () => {
    expect(schema.parse({ q: '  abc  ' })).toEqual({ q: 'abc' });
    expect(schema.parse({ q: ' abcde ' })).toEqual({ q: 'abcde' });
  });

  it('still enforces the inner schema', () => {
    expect(() => schema.parse({ q: 'abcdef' })).toThrow();
    expect(() => schema.parse({ q: 5 })).toThrow();
  });
});

describe('optionalList', () => {
  const schema = z.object({ codes: optionalList(z.string().regex(/^\d{2}$/), 2).describe('c') });

  it('drops blank elements and trims the rest', () => {
    expect(schema.parse({ codes: ['', ' 12 ', '  '] })).toEqual({ codes: ['12'] });
  });

  it('reads an all-blank or empty list as unset', () => {
    expect(schema.parse({ codes: ['', '  '] })).toEqual({ codes: undefined });
    expect(schema.parse({ codes: [] })).toEqual({ codes: undefined });
    expect(schema.parse({})).toEqual({});
  });

  it('applies the max after blanks are dropped', () => {
    expect(schema.parse({ codes: ['12', '', '07'] })).toEqual({ codes: ['12', '07'] });
    expect(() => schema.parse({ codes: ['12', '07', '99'] })).toThrow();
  });

  it('still validates each kept element and rejects a non-array', () => {
    expect(() => schema.parse({ codes: ['7'] })).toThrow();
    expect(() => schema.parse({ codes: '12' })).toThrow();
  });
});

describe('AGENCY_CODE', () => {
  it.each([['HHS'], ['HHS-NIH11'], ['DOT-FAA-FAA COE'], ['DOT-FTA - TPM'], ['A'], ['USDA-FNS1']])(
    'accepts %j',
    (code) => {
      expect(AGENCY_CODE.test(code)).toBe(true);
    },
  );

  it.each([['hhs'], ['-HHS'], ['HHS-'], ['HHS*'], ['HHS|DOE'], [''], [' HHS'], ['"HHS"']])(
    'rejects %j',
    (code) => {
      expect(AGENCY_CODE.test(code)).toBe(false);
    },
  );
});

describe('normalizeAgencyCode', () => {
  it('trims, uppercases, and collapses interior whitespace runs', () => {
    expect(normalizeAgencyCode(' hhs-nih11 ')).toBe('HHS-NIH11');
    expect(normalizeAgencyCode('dot-faa-faa   coe')).toBe('DOT-FAA-FAA COE');
    expect(normalizeAgencyCode('DOT-FTA\t-\tTPM')).toBe('DOT-FTA - TPM');
  });

  it('passes non-strings through for the schema to reject', () => {
    expect(normalizeAgencyCode(42)).toBe(42);
  });

  it('runs ahead of the pattern check when composed the way the tools compose it', () => {
    const schema = optionalText(z.preprocess(normalizeAgencyCode, z.string().regex(AGENCY_CODE)));
    expect(schema.parse('  hhs-nih11 ')).toBe('HHS-NIH11');
    expect(schema.parse('dot-faa-faa  coe')).toBe('DOT-FAA-FAA COE');
    expect(schema.parse('')).toBeUndefined();
    expect(() => schema.parse('hhs*')).toThrow();
  });
});
