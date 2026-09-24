/**
 * @fileoverview Tests for the shared input conventions: blank strings and
 * emptied lists read as unset, raw spellings normalize ahead of validation, and
 * the JSON Schema each tool advertises admits every raw form its descriptions
 * promise, so a client that validates arguments before sending never rejects
 * an accepted spelling.
 * @module tests/mcp-server/tools/input-schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { grantsgovGetOpportunity } from '@/mcp-server/tools/definitions/grantsgov-get-opportunity.tool.js';
import { grantsgovListReference } from '@/mcp-server/tools/definitions/grantsgov-list-reference.tool.js';
import { grantsgovSearchOpportunities } from '@/mcp-server/tools/definitions/grantsgov-search-opportunities.tool.js';
import {
  AGENCY_CODE,
  AGENCY_CODE_INPUT,
  blankToUndefined,
  normalizeAgencyCode,
  OPPORTUNITY_NUMBER_INPUT,
  optionalList,
  optionalText,
  rawPattern,
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
});

describe('rawPattern', () => {
  it('admits the core with surrounding whitespace, and a blank value', () => {
    const pattern = rawPattern('[A-Za-z]{1,4}');
    for (const value of ['hl', ' HL ', '', '   ']) expect(pattern.test(value)).toBe(true);
    for (const value of ['hlhlh', 'h l', '1']) expect(pattern.test(value)).toBe(false);
    expect(pattern.flags).toBe('');
  });
});

describe('AGENCY_CODE_INPUT', () => {
  const schema = optionalText(AGENCY_CODE_INPUT);

  it('normalizes the raw spelling to the code the handler receives', () => {
    expect(schema.parse('  hhs-nih11 ')).toBe('HHS-NIH11');
    expect(schema.parse('dot-faa-faa  coe')).toBe('DOT-FAA-FAA COE');
    expect(schema.parse('')).toBeUndefined();
  });

  it.each([['hhs*'], ['-HHS'], ['HHS-'], ['HHS|DOE'], ['"HHS"']])('rejects %j', (raw) => {
    expect(() => schema.parse(raw)).toThrow();
  });
});

describe('OPPORTUNITY_NUMBER_INPUT', () => {
  const schema = optionalText(OPPORTUNITY_NUMBER_INPUT);

  it('removes one pair of double quotes around the whole number, and trims', () => {
    expect(schema.parse('"HRSA-27-005"')).toBe('HRSA-27-005');
    expect(schema.parse('  " PAS-TUNIS- APS FY2026 " ')).toBe('PAS-TUNIS- APS FY2026');
    expect(schema.parse('HRSA-27-005')).toBe('HRSA-27-005');
  });

  it.each([['A"B'], ['""'], ['"HRSA-27-005'], ['""HRSA""'], ['x'.repeat(101)]])(
    'rejects %j',
    (raw) => {
      expect(() => schema.parse(raw)).toThrow();
    },
  );
});

/** JSON Schema as a tool advertises it in tools/list (argument-side view). */
type JsonSchema = {
  anyOf?: JsonSchema[];
  enum?: unknown[];
  items?: JsonSchema;
  maximum?: number;
  maxLength?: number;
  minimum?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  type?: string;
};

/** Whether a value satisfies the subset of JSON Schema the tool inputs emit. */
function admits(schema: JsonSchema, value: unknown): boolean {
  if (schema.anyOf) return schema.anyOf.some((branch) => admits(branch, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'array':
      return Array.isArray(value) && value.every((item) => admits(schema.items ?? {}, item));
    case 'integer':
      return (
        Number.isInteger(value) &&
        (schema.minimum === undefined || (value as number) >= schema.minimum) &&
        (schema.maximum === undefined || (value as number) <= schema.maximum)
      );
    case 'string':
      return (
        typeof value === 'string' &&
        (schema.pattern === undefined || new RegExp(schema.pattern).test(value)) &&
        (schema.maxLength === undefined || value.length <= schema.maxLength)
      );
    default:
      return true;
  }
}

const advertised = (input: z.ZodType) =>
  z.toJSONSchema(input, { io: 'input' }) as JsonSchema & {
    properties: Record<string, JsonSchema>;
  };

describe('advertised input schemas admit every raw form the descriptions promise', () => {
  const search = advertised(grantsgovSearchOpportunities.input);
  const get = advertised(grantsgovGetOpportunity.input);
  const reference = advertised(grantsgovListReference.input);

  it.each([
    ['agencies', [['hhs-nih11', ' HHS ', 'dot-faa-faa coe', 'NSF']]],
    ['eligibilities', [['7', 7, '07', ' 12 ', 99]]],
    ['funding_categories', [['hl', 'ED', ' st ']]],
    ['assistance_listing', ['93.866', '93866', '93.ech', ' ALN 93.866 ', 'CFDA: 93866', '']],
    ['opportunity_number', ['HRSA-27-005', '"HRSA-27-005"', 'PAS-TUNIS- APS FY2026', '']],
  ])('search %s', (field, values) => {
    const property = search.properties[field] as JsonSchema;
    for (const value of values) {
      expect(admits(property, value), `${field} ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it('search rejects at the advertised schema what the server rejects', () => {
    expect(admits(search.properties.agencies as JsonSchema, ['HHS*'])).toBe(false);
    expect(admits(search.properties.eligibilities as JsonSchema, ['123'])).toBe(false);
    expect(admits(search.properties.assistance_listing as JsonSchema, '93.866|47.076')).toBe(false);
    expect(admits(search.properties.opportunity_number as JsonSchema, 'A"B')).toBe(false);
  });

  it('get opportunity_ids and opportunity_numbers', () => {
    const ids = get.properties.opportunity_ids as JsonSchema;
    expect(admits(ids, [363423, '363423', ' 363423 '])).toBe(true);
    expect(admits(ids, ['abc'])).toBe(false);
    expect(admits(get.properties.opportunity_numbers as JsonSchema, ['"HRSA-27-005"', '1'])).toBe(
      true,
    );
  });

  it('list_reference parent_code', () => {
    const parent = reference.properties.parent_code as JsonSchema;
    for (const value of ['hhs', ' DOD-DARPA ', 'dot-faa-faa coe', '']) {
      expect(admits(parent, value), JSON.stringify(value)).toBe(true);
    }
  });

  it('parses every advertised raw form server-side to the normalized value', () => {
    const parsed = grantsgovSearchOpportunities.input.parse({
      agencies: ['hhs-nih11'],
      eligibilities: [7, '7', ' 12 '],
      funding_categories: ['hl'],
      assistance_listing: ' ALN 93.866 ',
      opportunity_number: '"HRSA-27-005"',
    });
    expect(parsed).toMatchObject({
      agencies: ['HHS-NIH11'],
      eligibilities: ['07', '07', '12'],
      funding_categories: ['HL'],
      assistance_listing: '93.866',
      opportunity_number: 'HRSA-27-005',
    });
    expect(
      grantsgovGetOpportunity.input.parse({
        opportunity_ids: ['363423', 363423],
        opportunity_numbers: ['"HRSA-27-005"'],
      }),
    ).toEqual({ opportunity_ids: [363423, 363423], opportunity_numbers: ['HRSA-27-005'] });
    expect(grantsgovListReference.input.parse({ topic: ' Agencies ', parent_code: 'hhs' })).toEqual(
      { topic: 'agencies', parent_code: 'HHS' },
    );
  });
});
