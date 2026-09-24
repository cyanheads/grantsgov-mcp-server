/**
 * @fileoverview Tests for compileKeyword: every row of the design's keyword
 * trap table, the supported pass-through syntax, and each rejection.
 * @module tests/services/grants-gov/keyword.test
 */

import { describe, expect, it } from 'vitest';
import { compileKeyword } from '@/services/grants-gov/keyword.js';

const compiled = (raw: string) => {
  const result = compileKeyword(raw);
  if (!result.ok) throw new Error(`Expected "${raw}" to compile, got: ${result.problem}`);
  return result;
};

const problem = (raw: string) => {
  const result = compileKeyword(raw);
  if (result.ok) throw new Error(`Expected "${raw}" to be rejected, got: ${result.compiled}`);
  return result.problem;
};

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
    ['title:broadband', 'title AND broadband'],
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
