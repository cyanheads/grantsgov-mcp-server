/**
 * @fileoverview Tests for compileKeyword: every row of the design's keyword
 * trap table, the supported pass-through syntax, each rejection, field-prefix
 * rejection, and the AND/OR grouping rule.
 * @module tests/services/grants-gov/keyword.test
 */

import { describe, expect, it } from 'vitest';
import { compileKeyword } from '@/services/grants-gov/keyword.js';

const compiled = (raw: string) => {
  const result = compileKeyword(raw);
  if (!result.ok) throw new Error(`Expected "${raw}" to compile, got: ${result.problem}`);
  return result;
};

const rejection = (raw: string) => {
  const result = compileKeyword(raw);
  if (result.ok) throw new Error(`Expected "${raw}" to be rejected, got: ${result.compiled}`);
  return result;
};

const problem = (raw: string) => rejection(raw).problem;

describe('compileKeyword — trap table', () => {
  it('ANDs bare adjacent terms (upstream reads them as implicit OR)', () => {
    expect(compiled('rural broadband')).toEqual({
      ok: true,
      compiled: 'rural AND broadband',
      andJoined: true,
    });
  });

  it.each([
    ['rural and broadband', 'rural AND broadband'],
    ['rural or tribal', 'rural OR tribal'],
    ['broadband not satellite', 'broadband AND NOT satellite'],
    ['rural Or tribal', 'rural OR tribal'],
  ])('reads lowercase/mixed-case operator words as operators: %s', (raw, expected) => {
    expect(compiled(raw).compiled).toBe(expected);
  });

  it('rejects a dangling trailing operator (upstream widens to nearly everything)', () => {
    expect(problem('rural AND broadband AND')).toBe('it ends with a dangling AND');
    expect(problem('rural OR')).toBe('it ends with a dangling OR');
    expect(problem('rural NOT')).toBe('it ends with a dangling NOT');
  });

  it('rejects an unbalanced double quote', () => {
    expect(problem('"unterminated')).toBe('it has an unbalanced double quote');
    expect(problem('rural "mental health')).toBe('it has an unbalanced double quote');
  });

  it('rejects unbalanced parentheses in both directions', () => {
    expect(problem('(rural')).toBe('it has an opening parenthesis with no matching closing one');
    expect(problem('rural)')).toBe('it has a closing parenthesis with no matching opening one');
  });

  it.each([
    ['COVID-19', '"COVID-19"'],
    ['K-12', '"K-12"'],
    ['93.866', '"93.866"'],
    ['U.S.', '"U.S."'],
  ])('auto-quotes a token with internal - or . as a phrase: %s', (raw, expected) => {
    expect(compiled(raw)).toEqual({ ok: true, compiled: expected, andJoined: false });
  });

  it('quotes punctuated tokens inside a larger expression and keeps negation outside the quotes', () => {
    expect(compiled('COVID-19 vaccine').compiled).toBe('"COVID-19" AND vaccine');
    expect(compiled('schools -K-12').compiled).toBe('schools AND -"K-12"');
  });

  it('leaves a punctuated wildcard token bare so * keeps working', () => {
    expect(compiled('COVID-19*').compiled).toBe('COVID-19*');
  });

  it('strips ? (single-char wildcard upstream)', () => {
    expect(compiled('broadband?').compiled).toBe('broadband');
  });

  it.each([
    ['Healthy Start: rural', 'Healthy AND Start AND rural'],
    ['broadband~', 'broadband'],
    ['[a TO z]', 'a AND TO AND z'],
    ['rural^2', 'rural AND 2'],
    ['rural\\broadband', 'rural AND broadband'],
    ['{rural}', 'rural'],
    ['!rural', 'rural'],
    ['+rural +broadband', 'rural AND broadband'],
    ['rural/urban', 'rural AND urban'],
  ])('replaces unsupported Lucene characters with a space: %s', (raw, expected) => {
    expect(compiled(raw).compiled).toBe(expected);
  });

  it('maps && and || to AND and OR', () => {
    expect(compiled('rural && broadband').compiled).toBe('rural AND broadband');
    expect(compiled('rural || tribal').compiled).toBe('rural OR tribal');
    expect(compiled('rural||tribal').compiled).toBe('rural OR tribal');
  });
});

describe('compileKeyword — supported syntax passes through', () => {
  it('keeps a quoted phrase as one operand', () => {
    expect(compiled('"mental health"')).toEqual({
      ok: true,
      compiled: '"mental health"',
      andJoined: false,
    });
  });

  it('collapses whitespace inside a phrase', () => {
    expect(compiled('"  mental   health "').compiled).toBe('"mental health"');
  });

  it('reads curly double quotes as straight ones', () => {
    expect(compiled('“mental health” services').compiled).toBe('"mental health" AND services');
  });

  it('keeps explicit AND/OR/NOT and parentheses', () => {
    expect(compiled('(rural OR tribal) AND broadband').compiled).toBe(
      '(rural OR tribal) AND broadband',
    );
    expect(compiled('(rural OR tribal) broadband').compiled).toBe(
      '(rural OR tribal) AND broadband',
    );
  });

  it('accepts a lone NOT term', () => {
    expect(compiled('NOT satellite')).toEqual({
      ok: true,
      compiled: 'NOT satellite',
      andJoined: false,
    });
  });

  it('keeps a leading -term and a negated phrase', () => {
    expect(compiled('broadband -satellite').compiled).toBe('broadband AND -satellite');
    expect(compiled('broadband -"low earth orbit"').compiled).toBe(
      'broadband AND -"low earth orbit"',
    );
  });

  it('turns -( … ) into NOT ( … )', () => {
    expect(compiled('broadband -(satellite OR wireless)').compiled).toBe(
      'broadband AND NOT (satellite OR wireless)',
    );
  });

  it('keeps a trailing * prefix wildcard', () => {
    expect(compiled('broad*').compiled).toBe('broad*');
  });

  it('drops lone - and * runs that carry no searchable content', () => {
    expect(compiled('rural - broadband').compiled).toBe('rural AND broadband');
    expect(compiled('rural * broadband').compiled).toBe('rural AND broadband');
  });

  it('reports andJoined only when AND joins operands', () => {
    expect(compiled('rural OR tribal').andJoined).toBe(false);
    expect(compiled('rural AND broadband').andJoined).toBe(true);
    expect(compiled('broadband').andJoined).toBe(false);
  });
});

describe('compileKeyword — rejections', () => {
  it('rejects a leading binary operator, at the start or inside a group', () => {
    expect(problem('AND rural')).toBe('it starts a group or the keyword with AND');
    expect(problem('OR rural')).toBe('it starts a group or the keyword with OR');
    expect(problem('broadband (OR rural)')).toBe('it starts a group or the keyword with OR');
  });

  it('rejects a binary operator right before a closing parenthesis', () => {
    expect(problem('(rural OR) broadband')).toBe('it ends with a dangling OR');
  });

  it('rejects doubled operators', () => {
    expect(problem('rural AND OR broadband')).toBe('it has AND followed directly by OR');
    expect(problem('rural NOT AND broadband')).toBe('it has NOT followed directly by AND');
    expect(problem('rural NOT NOT broadband')).toBe('it has NOT followed directly by NOT');
  });

  it('rejects an empty pair of parentheses', () => {
    expect(problem('rural ()')).toBe('it has an empty pair of parentheses');
  });

  it.each([['?~!'], ['""'], ['AND'], ['   '], ['- *'], ['()']])(
    'rejects a keyword with nothing searchable left: %j',
    (raw) => {
      expect(problem(raw)).toBe(
        'nothing searchable is left after removing unsupported characters and operators',
      );
    },
  );
});

describe('compileKeyword — field prefixes', () => {
  it.each([
    [
      'agency:NSF',
      'agency:NSF',
      'Drop "agency:" and pass NSF in the agencies filter (codes from grantsgov_list_reference topic agencies), or keep NSF as a plain keyword term to match it anywhere in the text.',
    ],
    [
      'cfda:93.866',
      'cfda:93.866',
      'Drop "cfda:" and pass 93.866 in the assistance_listing filter, or keep 93.866 as a plain keyword term to match it anywhere in the text.',
    ],
    [
      'rural -Agency_Code:HHS',
      'Agency_Code:HHS',
      'Drop "Agency_Code:" and pass HHS in the agencies filter (codes from grantsgov_list_reference topic agencies), or keep HHS as a plain keyword term to match it anywhere in the text.',
    ],
    [
      'broadband (oppnum:HRSA-27-005)',
      'oppnum:HRSA-27-005',
      'Drop "oppnum:" and pass HRSA-27-005 in the opportunity_number filter, or keep HRSA-27-005 as a plain keyword term to match it anywhere in the text.',
    ],
    [
      'description:opioid',
      'description:opioid',
      'Drop "description:" and keep opioid as a plain term; keyword already searches the title, description, opportunity number, and agency.',
    ],
    [
      'title:"rural health" grants',
      'title:"rural health"',
      'Drop "title:" and keep "rural health" as a plain term; keyword already searches the title, description, opportunity number, and agency.',
    ],
  ])('rejects %j with a hint naming the filter that does the job', (raw, syntax, hint) => {
    expect(rejection(raw)).toEqual({
      ok: false,
      problem: `it uses field syntax (${syntax}), which keyword does not support`,
      hint,
    });
  });

  it.each([
    ['"COVID-19: Response"', '"COVID-19 Response"'],
    ['Healthy Start: Eliminating', 'Healthy AND Start AND Eliminating'],
    ['https://grants.gov', 'https AND "grants.gov"'],
    ['time 11:59', 'time AND 11 AND 59'],
  ])('treats a colon that is not a field prefix as text: %j', (raw, expected) => {
    expect(compiled(raw).compiled).toBe(expected);
  });
});

describe('compileKeyword — AND/OR grouping', () => {
  it.each([
    [
      'broadband OR internet rural',
      'broadband OR internet AND rural',
      '(broadband OR internet) AND rural',
      'broadband OR (internet AND rural)',
    ],
    [
      'tribal OR rural broadband',
      'tribal OR rural AND broadband',
      '(tribal OR rural) AND broadband',
      'tribal OR (rural AND broadband)',
    ],
    ['a AND b OR c', 'a AND b OR c', 'a AND (b OR c)', '(a AND b) OR c'],
    [
      'rural OR tribal -satellite',
      'rural OR tribal AND -satellite',
      '(rural OR tribal) AND -satellite',
      'rural OR (tribal AND -satellite)',
    ],
    [
      'broadband (rural OR tribal health)',
      'rural OR tribal AND health',
      '(rural OR tribal) AND health',
      'rural OR (tribal AND health)',
    ],
    [
      'NOT satellite OR wireless broadband',
      'NOT satellite OR wireless AND broadband',
      '(NOT satellite OR wireless) AND broadband',
      'NOT satellite OR (wireless AND broadband)',
    ],
  ])(
    'rejects the ungrouped mix %j and spells out both groupings',
    (raw, level, orFirst, andFirst) => {
      expect(rejection(raw)).toEqual({
        ok: false,
        problem: `it mixes AND and OR without parentheses (${level}; bare terms are joined by AND), so which terms are alternatives is ambiguous`,
        hint: `Add parentheses to say which terms are alternatives, e.g. ${orFirst} or ${andFirst}.`,
      });
    },
  );

  it.each([
    ['(broadband OR internet) AND rural', '(broadband OR internet) AND rural'],
    ['broadband OR (internet AND rural)', 'broadband OR (internet AND rural)'],
    ['(broadband OR internet) rural', '(broadband OR internet) AND rural'],
    ['broadband OR (internet rural)', 'broadband OR (internet AND rural)'],
    ['rural OR tribal OR frontier', 'rural OR tribal OR frontier'],
    ['broadband NOT (satellite OR wireless)', 'broadband AND NOT (satellite OR wireless)'],
    [
      '(rural OR tribal) ((health OR clinic) -dental)',
      '(rural OR tribal) AND ((health OR clinic) AND -dental)',
    ],
  ])('accepts a keyword whose every group uses one operator: %j', (raw, expected) => {
    expect(compiled(raw).compiled).toBe(expected);
  });

  it('reports andJoined for a grouped keyword that requires every group', () => {
    expect(compiled('(rural OR tribal) broadband').andJoined).toBe(true);
    expect(compiled('rural OR (tribal AND broadband)').andJoined).toBe(true);
  });
});
