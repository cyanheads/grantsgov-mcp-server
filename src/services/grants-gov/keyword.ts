/**
 * @fileoverview Compiles a caller keyword into the form Grants.gov's search
 * parser reads as intended. The upstream grammar widens silently on implicit OR,
 * lowercase operators, dangling operators, and hyphen/period tokens; this
 * compiler ANDs bare terms, normalizes operators, auto-quotes punctuated tokens,
 * strips unsupported syntax, and rejects what it cannot repair.
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
  | { ok: false; problem: string };

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

/**
 * Compiles a keyword for `search2`.
 *
 * Supported and passed through: bare words, quoted phrases, `AND`/`OR`/`NOT` in
 * any case, `-term` negation, parentheses, trailing `*` prefix wildcards. `&&` and
 * `||` become `AND`/`OR`, `-(…)` becomes `NOT (…)`, and curly double quotes read
 * as straight ones. The characters `: ~ ? [ ] { } ^ \ / ! +` are replaced
 * by a space. Adjacent operands are joined with `AND`, and a token with an internal
 * `-` or `.` is quoted as a phrase. Unbalanced quotes or parentheses, a leading
 * binary operator, a trailing or doubled operator, and a keyword left empty after
 * cleaning are rejected with a `problem` phrased to follow "The keyword was
 * rejected because …".
 */
export function compileKeyword(raw: string): KeywordCompilation {
  const cleaned = raw
    .replace(/[“”]/g, '"')
    .replace(/&&/g, ' AND ')
    .replace(/\|\|/g, ' OR ')
    .replace(UNSUPPORTED, ' ');
  const tokens = tokenize(cleaned);
  if (typeof tokens === 'string') return { ok: false, problem: tokens };
  const joined = insertAnds(tokens);
  const problem = validate(joined);
  if (problem) return { ok: false, problem };
  return {
    ok: true,
    compiled: render(joined),
    andJoined: joined.some((t) => t.kind === 'op' && t.op === 'AND'),
  };
}
