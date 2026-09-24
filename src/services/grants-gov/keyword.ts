/**
 * @fileoverview Compiles a caller keyword into the form Grants.gov's search
 * parser reads as intended. The upstream grammar widens silently on implicit OR,
 * lowercase operators, dangling operators, and hyphen/period tokens, and drops
 * the OR branch of an ungrouped AND/OR mix; this compiler ANDs bare terms,
 * normalizes operators, auto-quotes punctuated tokens, strips unsupported
 * syntax, and rejects what it cannot repair: malformed syntax, field prefixes,
 * and AND mixed with OR without parentheses.
 * @module services/grants-gov/keyword
 */

/** Result of {@link compileKeyword}. */
export type KeywordCompilation =
  | {
      ok: true;
      /** The keyword to send upstream. */
      compiled: string;
      /** True when the compiled keyword joins operands with `AND` (explicit or inserted). */
      andJoined: boolean;
    }
  | {
      ok: false;
      /** Why the keyword was rejected, phrased to follow "The keyword was rejected because …". */
      problem: string;
      /** A recovery hint specific to this keyword; absent when the generic one applies. */
      hint?: string;
    };

type Token =
  | { kind: 'term'; text: string }
  | { kind: 'op'; op: 'AND' | 'OR' | 'NOT' }
  | { kind: 'open' }
  | { kind: 'close' };

/** Characters with upstream (Lucene) meanings the tool does not support. */
const UNSUPPORTED = /[:~?[\]{}^\\/!+]/g;

const OPERATOR_WORD = /^(and|or|not)$/i;

/** A word carrying at least one letter or digit; lone `-` or `*` runs carry nothing. */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

/** A token whose internal `-` or `.` would make the upstream split it and OR the parts. */
const INTERNAL_PUNCTUATION = /[\p{L}\p{N}][-.]+[\p{L}\p{N}]/u;

/** Splits the cleaned keyword into terms, phrases, operators, and parentheses. */
function tokenize(text: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '(' || ch === ')') {
      tokens.push({ kind: ch === '(' ? 'open' : 'close' });
      i++;
    } else if (ch === '-' && text[i + 1] === '(') {
      tokens.push({ kind: 'op', op: 'NOT' });
      i++;
    } else if (ch === '"' || (ch === '-' && text[i + 1] === '"')) {
      const prefix = ch === '-' ? '-' : '';
      const start = i + prefix.length + 1;
      const end = text.indexOf('"', start);
      if (end === -1) return 'it has an unbalanced double quote';
      const phrase = text.slice(start, end).trim().replace(/\s+/g, ' ');
      if (phrase) tokens.push({ kind: 'term', text: `${prefix}"${phrase}"` });
      i = end + 1;
    } else {
      let end = i;
      while (end < text.length && !/[\s()"]/.test(text[end] as string)) end++;
      const word = text.slice(i, end);
      i = end;
      if (OPERATOR_WORD.test(word)) {
        tokens.push({ kind: 'op', op: word.toUpperCase() as 'AND' | 'OR' | 'NOT' });
      } else if (HAS_CONTENT.test(word)) {
        tokens.push({ kind: 'term', text: quoteIfPunctuated(word) });
      }
    }
  }
  return tokens;
}

/** `COVID-19` → `"COVID-19"`, `-K-12` → `-"K-12"`; wildcard tokens stay bare so `*` keeps working. */
function quoteIfPunctuated(word: string): string {
  const negated = word.startsWith('-');
  const body = negated ? word.slice(1) : word;
  if (body.includes('*') || !INTERNAL_PUNCTUATION.test(body)) return word;
  return `${negated ? '-' : ''}"${body}"`;
}

const startsOperand = (t: Token) =>
  t.kind === 'term' || t.kind === 'open' || (t.kind === 'op' && t.op === 'NOT');
const endsOperand = (t: Token) => t.kind === 'term' || t.kind === 'close';
const isBinary = (t: Token | undefined) => t?.kind === 'op' && t.op !== 'NOT';

/** Inserts `AND` between adjacent operands so bare terms are all required. */
function insertAnds(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const prev = out.at(-1);
    if (prev && endsOperand(prev) && startsOperand(token)) out.push({ kind: 'op', op: 'AND' });
    out.push(token);
  }
  return out;
}

/** Returns a problem description for malformed token sequences, or `undefined` when valid. */
function validate(tokens: Token[]): string | undefined {
  if (!tokens.some((t) => t.kind === 'term')) {
    return 'nothing searchable is left after removing unsupported characters and operators';
  }
  let depth = 0;
  for (const [i, token] of tokens.entries()) {
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (token.kind === 'open') {
      depth++;
      if (next?.kind === 'close') return 'it has an empty pair of parentheses';
    } else if (token.kind === 'close') {
      if (--depth < 0) return 'it has a closing parenthesis with no matching opening one';
    } else if (token.kind === 'op') {
      if (token.op !== 'NOT' && (!prev || prev.kind === 'open')) {
        return `it starts a group or the keyword with ${token.op}`;
      }
      if (!next || next.kind === 'close') return `it ends with a dangling ${token.op}`;
      if (next.kind === 'op' && (isBinary(next) || token.op === 'NOT')) {
        return `it has ${token.op} followed directly by ${next.op}`;
      }
    }
  }
  return depth > 0 ? 'it has an opening parenthesis with no matching closing one' : undefined;
}

/** Joins tokens with single spaces, without padding the inside of parentheses. */
function render(tokens: Token[]): string {
  let out = '';
  for (const token of tokens) {
    const text =
      token.kind === 'term'
        ? token.text
        : token.kind === 'op'
          ? token.op
          : token.kind === 'open'
            ? '('
            : ')';
    const glue = out === '' || out.endsWith('(') || token.kind === 'close' ? '' : ' ';
    out += glue + text;
  }
  return out;
}

/** The filter parameter that does what a field prefix asks, keyed by the lowercased field name without `_`. */
const FIELD_FILTERS: Readonly<Record<string, string>> = {
  agency: 'agencies',
  agencies: 'agencies',
  agencycode: 'agencies',
  aln: 'assistance_listing',
  cfda: 'assistance_listing',
  assistancelisting: 'assistance_listing',
  number: 'opportunity_number',
  oppnum: 'opportunity_number',
  opportunitynumber: 'opportunity_number',
  eligibility: 'eligibilities',
  eligibilities: 'eligibilities',
  category: 'funding_categories',
  fundingcategory: 'funding_categories',
  instrument: 'funding_instruments',
  fundinginstrument: 'funding_instruments',
  status: 'statuses',
};

/** Filters whose values are codes listed by `grantsgov_list_reference`. */
const CODE_FILTERS = new Set([
  'agencies',
  'eligibilities',
  'funding_categories',
  'funding_instruments',
]);

/**
 * `name:value` with the value attached: `agency:NSF`, `-cfda:93.866`,
 * `(title:"rural health"`. A colon followed by a space (`Healthy Start:
 * Eliminating`) or a symbol (`https://…`) is not field syntax.
 */
const FIELD_PREFIX = /(?:^|[\s(+!])-?([A-Za-z][A-Za-z_]*):("[^"]*"|[\p{L}\p{N}][^\s()"]*)/du;

/**
 * Finds the first field prefix outside quoted phrases. The upstream would read
 * it as a field query; stripping the colon would instead AND the field name in
 * as a required term. Either way the result silently narrows, so it is rejected
 * with a hint naming the filter that does the same job.
 */
function fieldPrefixProblem(text: string): { problem: string; hint: string } | undefined {
  /** Phrase interiors are masked so a colon inside one is text; the quote marks stay so a quoted value reads as one. */
  const masked = text.replace(/"[^"]*"/g, (phrase) => `"${'x'.repeat(phrase.length - 2)}"`);
  const indices = FIELD_PREFIX.exec(masked)?.indices;
  if (!indices?.[1] || !indices[2]) return undefined;
  const field = text.slice(...indices[1]);
  const value = text.slice(...indices[2]);
  const filter = FIELD_FILTERS[field.toLowerCase().replace(/_/g, '')];
  const problem = `it uses field syntax (${field}:${value}), which keyword does not support`;
  if (filter === undefined) {
    return {
      problem,
      hint: `Drop "${field}:" and keep ${value} as a plain term; keyword already searches the title, description, opportunity number, and agency.`,
    };
  }
  const codes = CODE_FILTERS.has(filter)
    ? ` (codes from grantsgov_list_reference topic ${filter})`
    : '';
  return {
    problem,
    hint: `Drop "${field}:" and pass ${value} in the ${filter} filter${codes}, or keep ${value} as a plain keyword term to match it anywhere in the text.`,
  };
}

type Part = { kind: 'operand'; text: string } | { kind: 'op'; op: 'AND' | 'OR' };

const renderParts = (parts: readonly Part[]) =>
  parts.map((part) => (part.kind === 'operand' ? part.text : part.op)).join(' ');

/** Regroups one level so `tight` binds first: its runs are parenthesized, then joined by the other operator. */
function groupBy(parts: readonly Part[], tight: 'AND' | 'OR'): string {
  const loose = tight === 'AND' ? 'OR' : 'AND';
  const runs: string[][] = [[]];
  for (const part of parts) {
    if (part.kind === 'operand') runs.at(-1)?.push(part.text);
    else if (part.op === loose) runs.push([]);
  }
  return runs
    .map((run) => (run.length > 1 ? `(${run.join(` ${tight} `)})` : run[0]))
    .join(` ${loose} `);
}

/**
 * Rejects a grouping level (the whole keyword, or one pair of parentheses) that
 * joins operands with both AND and OR. Grants.gov does not apply boolean
 * precedence to such a mix (`broadband OR internet AND rural` returns exactly
 * `internet AND rural`), and callers split between reading OR or AND as binding
 * tighter, so neither reading can be sent on their behalf. The hint spells out
 * both groupings.
 */
function mixedOperatorProblem(
  tokens: readonly Token[],
): { problem: string; hint: string } | undefined {
  interface Level {
    negated: boolean;
    negateNext: boolean;
    parts: Part[];
  }
  const check = (level: Level) => {
    const ops = new Set(level.parts.flatMap((part) => (part.kind === 'op' ? [part.op] : [])));
    if (ops.size < 2) return;
    const text = renderParts(level.parts);
    const orFirst = groupBy(level.parts, 'OR');
    const andFirst = groupBy(level.parts, 'AND');
    return {
      problem: `it mixes AND and OR without parentheses (${text}; bare terms are joined by AND), so which terms are alternatives is ambiguous`,
      hint: `Add parentheses to say which terms are alternatives, e.g. ${orFirst} or ${andFirst}.`,
    };
  };

  const stack: Level[] = [{ parts: [], negateNext: false, negated: false }];
  for (const token of tokens) {
    const level = stack.at(-1) as Level;
    if (token.kind === 'term') {
      level.parts.push({ kind: 'operand', text: `${level.negateNext ? 'NOT ' : ''}${token.text}` });
      level.negateNext = false;
    } else if (token.kind === 'op') {
      if (token.op === 'NOT') level.negateNext = true;
      else level.parts.push({ kind: 'op', op: token.op });
    } else if (token.kind === 'open') {
      stack.push({ parts: [], negateNext: false, negated: level.negateNext });
      level.negateNext = false;
    } else {
      const closed = stack.pop() as Level;
      const mixed = check(closed);
      if (mixed) return mixed;
      (stack.at(-1) as Level).parts.push({
        kind: 'operand',
        text: `${closed.negated ? 'NOT ' : ''}(${renderParts(closed.parts)})`,
      });
    }
  }
  return check(stack[0] as Level);
}

/**
 * Compiles a keyword for `search2`.
 *
 * Supported and passed through: bare words, quoted phrases, `AND`/`OR`/`NOT` in
 * any case, `-term` negation, parentheses, trailing `*` prefix wildcards. `&&` and
 * `||` become `AND`/`OR`, `-(…)` becomes `NOT (…)`, and curly double quotes read
 * as straight ones. The characters `: ~ ? [ ] { } ^ \ / ! +` are replaced
 * by a space. Adjacent operands are joined with `AND`, and a token with an internal
 * `-` or `.` is quoted as a phrase. Rejected, with a `problem` phrased to follow
 * "The keyword was rejected because …": a field prefix (`agency:NSF`), unbalanced
 * quotes or parentheses, a leading binary operator, a trailing or doubled
 * operator, a keyword left empty after cleaning, and AND mixed with OR in one
 * grouping level (bare adjacent terms count as AND). A field prefix and an
 * AND/OR mix also carry a keyword-specific `hint`.
 */
export function compileKeyword(raw: string): KeywordCompilation {
  const straightQuoted = raw.replace(/[“”]/g, '"');
  const field = fieldPrefixProblem(straightQuoted);
  if (field) return { ok: false, ...field };
  const cleaned = straightQuoted
    .replace(/&&/g, ' AND ')
    .replace(/\|\|/g, ' OR ')
    .replace(UNSUPPORTED, ' ');
  const tokens = tokenize(cleaned);
  if (typeof tokens === 'string') return { ok: false, problem: tokens };
  const joined = insertAnds(tokens);
  const problem = validate(joined);
  if (problem) return { ok: false, problem };
  const mixed = mixedOperatorProblem(joined);
  if (mixed) return { ok: false, ...mixed };
  return {
    ok: true,
    compiled: render(joined),
    andJoined: joined.some((t) => t.kind === 'op' && t.op === 'AND'),
  };
}
