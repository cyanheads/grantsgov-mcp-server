# grantsgov-mcp-server — Design

Search US federal grant opportunities on Grants.gov and read full opportunity detail: eligibility, award range, deadlines, attachments. It wraps the keyless legacy Grants.gov REST API (`https://api.grants.gov/v1/api`: `POST search2`, `POST fetchOpportunity`), which serves every federal agency's forecasted, posted, closed, and archived funding opportunities (~83K records).

> **Every request/response field below was confirmed against the live API on 2026-09-24 (ET)**, then re-probed in a cold review the same day (probe table in [API Reference](#api-reference)). Counts cited as examples are as of that date.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `grantsgov_search_opportunities` | Search federal funding opportunities by keyword, agency, applicant eligibility, funding category/instrument, assistance listing, opportunity number, posting window, or closing window. Returns deadline-first rows plus facet counts for refining. | `keyword`, `statuses`, `agencies`, `eligibilities`, `include_unrestricted`, `funding_categories`, `funding_instruments`, `assistance_listing`, `opportunity_number`, `posted_within_days`, `closing_within_days`, `sort`, `limit`, `offset`, `include_facets` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `grantsgov_get_opportunity` | Read the full record for 1–5 opportunities by numeric id or opportunity number: deadline, award range, eligibility codes and narrative, description, assistance listings, agency contact, attachments, application packages. | `opportunity_ids`, `opportunity_numbers` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `grantsgov_list_reference` | Decode the codes the search filters take (agencies, applicant eligibility, funding categories and instruments), plus statuses, sort options, and keyword syntax. | `topic`, `name_contains`, `parent_code` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |

### Resources

None. Every record is reachable through `grantsgov_get_opportunity`; see [Decisions Log](#decisions-log).

### Prompts

None.

---

## Overview

Grants.gov is the single federal portal where agencies post discretionary funding solicitations. The server answers "what federal funding is open for X right now, can my organization apply, how much, and by when," then carries the join keys (assistance listing number, opportunity number) out to other sources.

Audience: nonprofits, universities, tribes, local governments, and small businesses looking for funding; grant-writing agents; civic-tech and public-money tooling.

Two identifiers run through the surface:

| Identifier | Example | Where it comes from | Where it goes |
|:-----------|:--------|:--------------------|:--------------|
| Opportunity id | `363423` | `search2` rows (`id`, a digit string) and `fetchOpportunity` (`id`, an integer) | `grantsgov_get_opportunity.opportunity_ids`; public URL `https://www.grants.gov/search-results-detail/{id}` |
| Opportunity number | `HRSA-27-005`, `PAR-25-144`, `26-523` | Agency-assigned | `grantsgov_search_opportunities.opportunity_number`, `grantsgov_get_opportunity.opportunity_numbers` |

The opportunity number is **not unique**: `oppNum: "1"` returns five archived records from four agencies. Resolution by number therefore has an `ambiguous` outcome.

## Requirements

- Keyless. No env vars required. No published rate limit; a 25-request burst returned 25× 200 (idea-stage probe, not repeated).
- Read-only. Nothing is written upstream.
- Every tool works for a user who installs only this server.
- Every silent-widening or silent-empty upstream behavior is closed at the tool boundary: the input is mapped to the working form, or the call is rejected with a typed error naming the fix.
- Deadline first. Close date relative to today (Eastern Time, the zone Grants.gov publishes in) leads every row and record.
- Agency-authored text (titles, descriptions, eligibility narrative, close-date explanations, contact blocks) is untrusted data. See [Untrusted text handling](#untrusted-text-handling).

## User Goals

1. Find open or upcoming opportunities matching a topic, agency, applicant type, or funding category ("open NSF education grants a nonprofit can apply to"). → search
2. Find what closes soon ("posted opportunities closing in the next 30 days for tribal governments"). → search `closing_within_days`
3. Find what was posted recently ("new HHS forecasts this week"). → search `posted_within_days`
4. Read one opportunity in full: eligibility (codes and narrative), award ceiling/floor, expected awards, total funding, cost sharing, key dates, contact, NOFO attachments. → get
5. Look up an opportunity when all the user has is its number. → get `opportunity_numbers`, or search `opportunity_number`
6. Ground filters in valid codes, since agency codes like `HHS-NIH11` are opaque. → list_reference
7. Carry join keys to other sources: the assistance listing number (ALN, formerly CFDA) and the opportunity number. → surfaced on every row and record

---

## Tools — detail

### Shared input conventions

These apply to every tool and are written once here so each param table can reference them.

**Blank means unset.** Form clients submit every optional field, blank. Optional string inputs are wrapped so `''` or whitespace-only reads as `undefined`. This is never `.min(1)`:

```ts
/** Treat blank/whitespace-only strings as unset; trim everything else. */
const blankToUndefined = (v: unknown) =>
  typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v;

const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());
```

Optional arrays get the same treatment. Blank elements are dropped, and an array left empty reads as unset:

```ts
const optionalList = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess(
    (v) => {
      if (!Array.isArray(v)) return v;
      const kept = v.map(blankToUndefined).filter((x) => x !== undefined);
      return kept.length === 0 ? undefined : kept;
    },
    z.array(item).max(max).optional(),
  );
```

**Normalization runs in the schema, before the pattern check.** Every normalization a `.describe()` promises (trim, case, zero-padding, prefix stripping) happens in an item-level `z.preprocess` ahead of the `regex`/`enum`, so the pattern validates the normalized value. The handler never sees the raw form.

**Optional numbers** (`posted_within_days`, `closing_within_days`) accept `''` as unset through the same `blankToUndefined` preprocess, then `z.number().int()` with bounds. A digit string (`"30"`) is coerced to a number in the preprocess because the mapping is exact.

### `grantsgov_search_opportunities`

**Description (draft):** `Search federal funding opportunities on Grants.gov by keyword, agency, applicant eligibility, funding category, funding instrument, assistance listing, or opportunity number. Returns forecasted and posted opportunities unless statuses says otherwise, each row led by its close date and days remaining, plus facet counts for narrowing. Keyword terms are all required; join alternatives with OR. Rows carry no award amounts or eligibility detail; read those with grantsgov_get_opportunity. Filter codes come from grantsgov_list_reference.`

#### Params

| Param | Type | Maps to (`search2` body) | Notes |
|:------|:-----|:-------------------------|:------|
| `keyword` | `optionalText(z.string().max(500))` | `keyword` (after [keyword compilation](#keyword-compilation)) | Full-text over title, description, number, agency. Terms are ANDed by the tool. The compiled string is echoed as `effective_keyword`. |
| `statuses` | `optionalList(z.preprocess(lowercase, z.enum(['forecasted','posted','closed','archived'])), 4)` | `oppStatuses`, **pipe-joined string** | Default `['forecasted','posted']`, applied by the handler and echoed with `statuses_defaulted: true`. Case normalized (`Posted` → `posted`). The upstream takes a pipe string only: an array returns 0, and comma-joined returns 0. |
| `agencies` | `optionalList(z.preprocess(normalizeAgencyCode, z.string().regex(AGENCY_CODE)), 10)` | `agencies`, pipe-joined, each code expanded and quoted as needed ([agency code encoding](#agency-code-encoding)) | `normalizeAgencyCode`: trim, uppercase (`hhs-nih11` → `HHS-NIH11`; lowercase returns 0 upstream), collapse internal whitespace runs to one space. `AGENCY_CODE = /^[A-Z0-9](?:[A-Z0-9 -]*[A-Z0-9])?$/`: ten real codes contain spaces (`DOT-FAA-FAA COE`, `DOT-FTA - TPM`, `DOT-DOT X-50`). Validated against the reference snapshot. Unknown → `unknown_agency`. |
| `eligibilities` | `optionalList(z.preprocess(trimPad2, z.string().regex(/^\d{2}$/)), 17)` | `eligibilities`, pipe-joined | Applicant-type codes. Single digits zero-padded (`7` → `07`; bare `7` returns 0 upstream). Validated against the snapshot; unknown → `unknown_eligibility`. OR within the list. |
| `include_unrestricted` | `z.boolean().default(true)` | adds `99` to `eligibilities` | Only acts when `eligibilities` is set and lacks `99`. Code `99` ("Unrestricted — open to any type of entity") is a separate code: filtering on `12` alone misses every unrestricted opportunity a 501(c)(3) could apply to. Echoed. |
| `funding_categories` | `optionalList(z.preprocess(trimUpper, z.string().regex(/^[A-Z]{1,4}$/)), 28)` | `fundingCategories`, pipe-joined | Uppercased (`hl` → `HL`; lowercase returns 0). Validated against the snapshot; unknown → `unknown_funding_category`. |
| `funding_instruments` | `optionalList(z.preprocess(trimUpper, z.enum(['G','CA','PC','O'])), 4)` | `fundingInstruments`, pipe-joined | Grant, Cooperative Agreement, Procurement Contract, Other. Uppercased (`g` returns 0 upstream). |
| `assistance_listing` | `optionalText(z.preprocess(normalizeAln, z.string().regex(/^\d{2}\.[0-9A-Z]{3}$/)))` | `cfda` | **Single value.** Upstream ignores pipes (`93.866\|47.076` → 0). `normalizeAln`: trim, uppercase, strip a leading `ALN`/`CFDA` label, insert the dot into a 5-char form (`93866` → `93.866`). ALNs can be alphanumeric (`93.ECH`, `93.U01`-style), hence `[0-9A-Z]`. The documented `aln` key is ignored upstream; only `cfda` works. |
| `opportunity_number` | `optionalText(z.string().max(100).regex(/^[^"]+$/))` | `oppNum`, **always wrapped in double quotes** | The upstream parses `oppNum` as a query, not a literal: `PAR-25-14*` is a wildcard (8 hits), and a number containing a space matches nothing unquoted (`PAS-TUNIS- APS FY2026` → 0, quoted → 1). Quoting makes it literal (`"PAR-25-14*"` → 0) and is harmless for plain numbers. `"` is rejected by the schema; no real number contains one. Case-sensitive upstream (`hrsa-27-005` → 0): sent as given, and on zero exact matches with lowercase letters present, retried once uppercased. Rows are post-filtered to exact equality (after trim, case-insensitive), because `oppNum: "1"` also returns an unrelated `21561-9-F017A`, quoted or not. **Paging in this mode is local:** fetch `rows: 100` at offset 0 with the caller's other filters, filter, then slice by `offset`/`limit`; `totalCount` is the filtered count, never the upstream `hitCount`. |
| `posted_within_days` | `z.preprocess(blankOrDigits, z.number().int().min(1).max(3650).optional())` | `dateRange` (string of the integer) | Posting date within the last N days. Upstream returns 0 for `0`, negatives, and non-numerics, hence `min(1)`. **Only valid when every status is `forecasted` or `posted`**. With `closed`/`archived`, the upstream drops the status filter and returns forecasted+posted rows. → `filter_conflict`. |
| `closing_within_days` | `z.preprocess(blankOrDigits, z.number().int().min(0).max(365).optional())` | `oppStatuses: 'posted'`, `sortBy: 'closeDate\|asc'`, then a server-side window cut | `0` = closing today (ET). Forces `statuses = ['posted']` and `sort = close_date_asc`; an explicit conflicting `statuses` or `sort` → `filter_conflict`. There is no upstream close-date filter. See [Closing-window scan](#closing-window-scan). |
| `sort` | `z.enum([...]).optional()` | `sortBy` | `relevance` (omit `sortBy`), `open_date_desc`/`open_date_asc` (`openDate\|desc/asc`), `close_date_asc`/`close_date_desc` (`closeDate\|…`), `opportunity_number_asc`/`_desc` (`oppNum\|…`), `agency_asc`/`_desc` (`agency\|…`). Default: `relevance` when `keyword` is set, else `open_date_desc`. Echoed. Any other `sortBy` (`relevance`, `title\|asc`, `oppTitle\|asc`, `openDate` with no direction) returns 0 upstream, so the enum is the allowlist. |
| `limit` | `z.number().int().min(1).max(100).default(25)` | `rows` | The upstream has no rows cap (10,000 returned in one call); 100 is a context cap. |
| `offset` | `z.number().int().min(0).max(100000).default(0)` | `startRecordNum` | 0-based. Past the end, upstream returns 0 rows with the true `hitCount`, which gets a notice. |
| `include_facets` | `z.boolean().default(true)` | none (`search2` always returns facets) | `false` drops the ~4 KB facet block when paging. |

The body is built from a typed interface holding exactly the twelve verified keys. An unknown key is ignored upstream and silently widens to the default scope (`{"foo":"bar"}` → 1,531, same as `{}`), so no field ever passes through by name.

#### Agency code encoding

The upstream parses `agencies` as a query too. A code containing a space must be sent double-quoted, or it is split into terms and silently mismatches: `DOT-FAA-FAA COE` unquoted → 0 (quoted → 4); `DOT-FTA - TPM` unquoted → 197, which is `DOT-FTA`'s count, not its own 2. Each validated code is encoded from the snapshot:

1. **Self.** A space-free code is sent bare; a code with a space is sent as `"CODE"`.
2. **Descendants** (only when the snapshot has codes under it; a prefix-only value such as `HHS-OS` sends just `HHS-OS-*`). A space-free code adds `CODE-*`: the `-*` suffix wildcard is an exact subtree at every level (`DOC` → 8, `DOC\|DOC-*` → 24), while a bare parent matches only records filed at exactly that code (`HHS` → 0, `HHS\|HHS-*` → 940 open). `CODE*` is never used: 27 codes are non-hyphen prefixes of unrelated codes (`USDA-FS` → `USDA-FSA`, `USDA-FSIS`; `DOS-PA` → `DOS-PAK`). A code with a space cannot carry a wildcard inside quotes, so each of its snapshot descendants is listed explicitly, quoted (`"DOT-FAA-FAA COE"\|"DOT-FAA-FAA COE-AJFE"\|…` → 9, matching the subtree).
3. **Descendants the wildcard misses.** Any snapshot descendant that `CODE-*` cannot match (`DOT-FTA - TPM` under `DOT-FTA`) is appended explicitly, quoted.

The encoded, pipe-joined string is echoed as `applied_filters.agencies_sent`.

#### Keyword compilation

The upstream keyword grammar was probed and has these traps. Each one returns HTTP 200, `errorcode: 0`, and a plausible count:

| Input | Upstream behavior | Tool behavior |
|:------|:------------------|:--------------|
| `rural broadband` | Implicit **OR** (120 ≈ 108 ∪ 19) | Bare adjacent terms joined with `AND` → `rural AND broadband` (7). The tool contract is all-terms, documented in `.describe()`. |
| `rural and broadband` | Lowercase `and` is indexed as a term matching nearly everything (1,494) | `and`/`or`/`not` (any case) standing alone between terms are operators, uppercased. |
| `rural AND broadband AND` | Dangling operator widens to 1,494 | Rejected: `invalid_keyword`. |
| `"unterminated` / `(rural` | Unbalanced quote → 0; unbalanced paren tolerated | Rejected: `invalid_keyword`. |
| `COVID-19`, `K-12`, `93.866` | Split on `-`/`.` and ORed (`COVID-19` → 300, quoted → 24) | A token with an internal `-` or `.` is auto-quoted as a phrase. |
| `broadband?` | `?` is a single-char wildcard (5 vs 19) | Stripped with the other unsupported specials. |
| `title:broadband`, `broadband~`, `[a TO z]`, `^`, `\`, `{}`, `!`, `+` | Field syntax → 0; `~` fuzzy; range → everything; `+` ignored | Characters `: ~ ? [ ] { } ^ \ / ! +` replaced by a space before tokenizing. `&&` → `AND`, `\|\|` → `OR`. |

Supported, and passed through as-is: quoted phrases (`"mental health"` → 109), `AND`/`OR`/`NOT`, leading `-term` (= `NOT term`), parentheses (`(rural OR tribal) AND broadband` → 18), trailing `*` prefix wildcard (`broad*` → 477). A lone `NOT term` is valid (1,512).

`compileKeyword(raw): { ok: true, compiled } | { ok: false, problem }` is a pure function in the service layer. Steps: replace unsupported specials → tokenize (quoted phrases, parens, words) → classify operators → auto-quote internal-punctuation tokens → insert `AND` between adjacent operands → validate (balanced quotes/parens, no leading `AND`/`OR`, no trailing operator, no two binary operators adjacent) → join. If nothing remains after stripping (keyword was only specials), the result is `invalid_keyword`. The handler maps `ok: false` to `ctx.fail('invalid_keyword', …)`.

#### Closing-window scan

Probed on posted opportunities with `sortBy: closeDate|asc`: close dates are monotonic, the first row is today (ET), blank close dates sort last (77 of 940), and far-future placeholders sit in date order near the end. The scan:

1. `cutoff = todayET + closing_within_days`.
2. Page `search2` with the caller's other filters, `oppStatuses: 'posted'`, `sortBy: 'closeDate|asc'`, `rows: 500`, `startRecordNum: 0, 500, …`.
3. Stop at the first row whose close date is blank or later than `cutoff`, when a page comes back short, or after 2,000 rows scanned (a hard ceiling; the whole posted universe is 940). Hitting the ceiling sets a notice. The first row past the window is kept as `nextCloseAfterWindow` for the empty-window notice.
4. The window is `todayET ≤ close_date ≤ cutoff`. A posted row dated before today (a status flip the upstream has not run yet) is skipped, not counted. `window_total` = rows inside the window. The returned page is `window.slice(offset, offset + limit)`.

With `opportunity_number` also set, the scan sends the quoted `oppNum` and applies the exact-equality filter to the window before slicing. One call covers the typical case (242 posted opportunities closed within 30 days at the idea-stage probe). Facet counts in this mode describe the whole posted set matching the other filters, not the window. The notice says so when facets are included.

#### Output

```ts
output: z.object({
  opportunities: z.array(z.object({
    opportunity_id: z.string().describe('Numeric Grants.gov id as a digit string. Pass to grantsgov_get_opportunity.opportunity_ids.'),
    opportunity_number: z.string().describe('Agency-assigned opportunity number, e.g. HRSA-27-005.'),
    title: z.string().describe('Opportunity title (HTML entities decoded).'),
    status: z.enum(['forecasted','posted','closed','archived']).describe('Lifecycle status.'),
    doc_type: z.enum(['synopsis','forecast']).describe('Whether the record is a posted synopsis or a forecast.'),
    agency_code: z.string().describe('Owning agency code, e.g. HHS-HRSA.'),
    agency_name: z.string().describe('Owning agency name.'),
    open_date: z.string().optional().describe('Posting date, YYYY-MM-DD. Omitted when not listed.'),
    close_date: z.string().optional().describe('Close date as listed, YYYY-MM-DD. Omitted when none is listed.'),
    close_date_kind: z.enum(['fixed','none_listed','placeholder']).describe('fixed = a real deadline; none_listed = no close date in search (rolling or open-ended, and every forecast: its estimated close date is on the grantsgov_get_opportunity record); placeholder = a far-future stand-in date the agency uses for "accepted anytime".'),
    days_until_close: z.number().int().optional().describe('Days from today (US Eastern) to close_date. Present only when close_date_kind is fixed; 0 = closes today; negative for a posted record whose close date passed before Grants.gov updated its status.'),
    assistance_listings: z.array(z.string()).describe('Assistance listing numbers (ALN, formerly CFDA). Empty when none listed.'),
  })).describe('Matching opportunities, deadline first.'),
  facets: z.object({
    statuses: FacetList, eligibilities: FacetList, funding_categories: FacetList,
    funding_instruments: FacetList, agencies: FacetList,
    sub_agencies: FacetList.optional(),
  }).optional().describe('Counts per filter value for the current filters. Omitted when include_facets is false.'),
})
// FacetList = z.array(z.object({ code, label, count })).describe(...)
```

- **Close-date mapping.** `closeDate: ""` → `close_date` absent, `none_listed`. Forecast rows never carry a search close date (548 of 548 forecasts sampled), so every forecast row is `none_listed`; the estimate lives on the detail record (`forecast_estimates.est_close_date`). A year ≥ current ET year + 25 → `placeholder`, with the date kept as listed and no `days_until_close`. This covers the `01/01/2099` sentinel (12 posted DOS listings) and the NSF "Proposals accepted anytime" dates (`08/17/2076`, 13 posted NSF listings, whose detail record says so in `responseDateDesc`). Long-running DOD BAAs closing in 2034–2044 stay `fixed`. Search close dates are date-only; no time is reported.
- `facets.statuses` counts all four statuses for the other filters, regardless of the `statuses` filter (upstream `oppStatusOptions` behavior). That is what makes the "add closed/archived" notice possible.
- `facets.agencies` is the top-level list. `sub_agencies` is present only when an `agencies` filter is set, and lists the `subAgencyOptions` of the top-level agencies in the result.
- Labels are trimmed (20 of 940 agency names carry a trailing space).

#### Enrichment

```ts
enrichment: {
  totalCount: z.number().describe('Total matching opportunities (the closing-window count in closing_within_days mode).'),
  truncated: z.boolean().describe('True when more rows exist past this page.'),
  shown: z.number().describe('Rows returned on this page.'),
  cap: z.number().describe('The limit applied.'),
  next_offset: z.number().optional().describe('Offset for the next page; absent on the last page.'),
  effective_keyword: z.string().optional().describe('The keyword as compiled and sent upstream.'),
  applied_filters: z.object({ statuses, statuses_defaulted, agencies_sent, eligibilities_sent, include_unrestricted, funding_categories, funding_instruments, assistance_listing, opportunity_number, posted_within_days, closing_within_days, closing_cutoff_date, sort }).describe('Filters as the server applied them, including defaults and expansions.'),
  notice: z.string().optional().describe('Zero-hit or window guidance naming the next call.'),
},
enrichmentTrailer: { applied_filters: { render: renderAppliedFilters } },
```

**Required fields are written unconditionally before the handler branches.** The first enrichment call runs straight after input normalization, ahead of the upstream call and any mode branch:

```ts
ctx.enrich({ totalCount: 0, truncated: false, shown: 0, cap: input.limit, applied_filters: applied });
// …search, opportunity-number, or closing-window branch…
ctx.enrich({ totalCount: total, shown: rows.length });
const notice = composeNotice(/* zero-hit, window, scan-ceiling, facet-scope fragments */);
if (input.offset + rows.length < total) {
  ctx.enrich({ next_offset: input.offset + rows.length });
  ctx.enrich.truncated({ shown: rows.length, cap: input.limit, guidance: notice ?? `More results: call again with offset ${input.offset + rows.length}.` });
} else if (notice) {
  ctx.enrich.notice(notice);
}
```

A write from one branch only would fail the framework's `output.extend(enrichment)` parse on every other page. `ctx.enrich.truncated()` always writes `notice` (its `guidance`, or a generated default) and the last write wins, so every notice fragment is composed into one string first and passed through a single final write, never written separately before it.

#### Outcome states

| State | Condition | Result |
|:------|:----------|:-------|
| Page of results | `0 < shown ≤ limit` | Rows + facets; `truncated`/`next_offset` when more remain. |
| Last page | `offset + shown == totalCount` | `truncated: false`, no `next_offset`. |
| Offset past end | `offset ≥ totalCount > 0` | Empty rows + notice: `Offset {offset} is past the end of {totalCount} results. Call again with offset 0, or a multiple of limit below {totalCount}.` |
| Zero hits | `totalCount == 0` | Success, empty rows, composed notice (below). |
| Window empty, posted matches exist | closing mode, `window_total == 0`, posted hits > 0 | When `nextCloseAfterWindow` is a `fixed` date with `d ≤ 365`: `No posted opportunity matching these filters closes within {N} days; the next one closes {date} ({d} days). Raise closing_within_days to at least {d}.` Otherwise (blank, placeholder, or more than 365 days out): `No posted opportunity matching these filters has a fixed deadline within {N} days; all {postedTotal} posted matches close later or list no fixed date. Call grantsgov_search_opportunities without closing_within_days and with sort close_date_asc to see them.` |
| Scan ceiling hit | 2,000 rows scanned without leaving the window | Rows as scanned + notice: `The closing window holds more than 2,000 opportunities; results cover the first 2,000 by close date. Add filters to narrow.` |
| Invalid input | see errors | Typed error. |

**Zero-hit notice composition.** Fragments append in this order when their condition holds. The last fragment is always present:

| Condition | Fragment |
|:----------|:---------|
| `statuses` defaulted and `facets.statuses` shows closed/archived matches | `{c} closed and {a} archived opportunities match; add "closed" and/or "archived" to statuses to include them.` |
| `keyword` compiled to ≥2 ANDed operands | `All keyword terms were required ({effective_keyword}); join alternatives with OR, or drop a term.` |
| `eligibilities` set and `include_unrestricted: false` | `Set include_unrestricted to true to add opportunities open to any applicant type.` |
| `posted_within_days` set | `Raise posted_within_days or remove it; it limits results to opportunities posted in the last {N} days.` |
| `opportunity_number` set | `opportunity_number is exact-match; call grantsgov_get_opportunity with opportunity_numbers to search every status, or put the number in quotes in keyword for a full-text match.` |
| any of `agencies`/`eligibilities`/`funding_categories`/`funding_instruments`/`assistance_listing` set | `Remove one filter at a time, or call grantsgov_list_reference to confirm the codes.` |
| always | `Rerun with fewer filters to see facet counts for refining.` |

#### Error contract

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `invalid_keyword` | `ValidationError` | Keyword has unbalanced quotes or parentheses, a leading `AND`/`OR`, a trailing or doubled operator, or nothing left after removing unsupported characters. | `Fix the keyword syntax, or call grantsgov_list_reference with topic keyword_syntax for the supported operators.` |
| `unknown_agency` | `ValidationError` | An `agencies` code is neither a snapshot code nor a hyphen-delimited prefix of one (six prefixes such as `HHS-OS` group real codes without being codes themselves; they encode as their `-*` subtree). | `Call grantsgov_list_reference with topic agencies and name_contains set to the agency name to find its code.` |
| `unknown_eligibility` | `ValidationError` | An `eligibilities` code is not in the applicant-type list. | `Call grantsgov_list_reference with topic eligibilities for the valid two-digit applicant-type codes.` |
| `unknown_funding_category` | `ValidationError` | A `funding_categories` code is not in the category list. | `Call grantsgov_list_reference with topic funding_categories for the valid category codes.` |
| `filter_conflict` | `ValidationError` | `posted_within_days` with `closed`/`archived` in statuses; `closing_within_days` with statuses other than `['posted']` or a sort other than `close_date_asc`. | `Remove the conflicting statuses or sort value and call grantsgov_search_opportunities again.` (Dynamic hint names the exact field to drop.) |
| `upstream_unavailable` | `ServiceUnavailable`, `retryable: true`, `thrownBy: 'service'` | Grants.gov returned 5xx, an HTML/non-JSON body, a non-zero `errorcode`, or the "backend … is not available" in-band message after retries. | `Grants.gov is not responding; wait a minute and call grantsgov_search_opportunities again.` |
| `upstream_route_unavailable` | `ServiceUnavailable`, `retryable: false`, `thrownBy: 'service'` | HTTP 403 `Missing Authentication Token`: the route no longer exists at the gateway. | `The Grants.gov search API route is not answering; the legacy API may have been retired, so report this to the server maintainer.` |

Dynamic hints (`ctx.fail(reason, msg, { recovery: { hint } })`) interpolate the offending value where it helps. For example, `unknown_agency` names the rejected code, and `filter_conflict` names the field to drop.

### `grantsgov_get_opportunity`

**Description (draft):** `Read the full Grants.gov record for up to 5 opportunities, given numeric opportunity ids or opportunity numbers: deadline and its explanation, award ceiling and floor, total funding, expected awards, cost sharing, eligible applicant types with the eligibility narrative, description, assistance listings, agency contact, NOFO attachments with download links, and application packages. An opportunity number is resolved across all statuses. A miss or an ambiguous number comes back as an unresolved entry with guidance, not an error.`

#### Params

| Param | Type | Maps to | Notes |
|:------|:-----|:--------|:------|
| `opportunity_ids` | `optionalList(z.preprocess(digitsToNumber, z.number().int().min(1)), 5)` | `fetchOpportunity` body `{ opportunityId }` | Accepts `363423` or `"363423"` (the search tool emits digit strings). |
| `opportunity_numbers` | `optionalList(z.string().max(100).regex(/^[^"]+$/), 5)` | `search2` `oppNum` (double-quoted, all four statuses, `rows: 10`) → id → `fetchOpportunity` | Trimmed in the item preprocess; internal spaces kept (`PAS-TUNIS- APS FY2026` is a real number). Quoted for the same reason as in search. Resolved as given; on no exact match with lowercase present, retried uppercased. Exact equality post-filter (case-insensitive), as in search. |

At least one list must be non-empty, and the combined count must be ≤ 5. Both are handler checks (`no_identifiers`, `too_many_identifiers`), because a root refine does not surface in JSON Schema. Duplicate inputs are de-duplicated before any call. Ids resolved from numbers merge with direct ids, and a record is fetched once.

The two lists are separate because digit-only opportunity numbers exist (`"1"` is a real, archived number). One mixed list would make such a value ambiguous between an id and a number.

#### Upstream outcomes (probed)

| Input | HTTP | Body | Classification |
|:------|:-----|:-----|:---------------|
| Known id (`363423`, or `"363423"`) | 200 | `data.id` set, full record | `found` |
| Unknown id (`999999999`) | 200 | `data.id: null`, `data.errorMessages: ["There is no record found for your search."]` | `not_found` result |
| `0` | 200 | `data.errorMsgs: ["Opportunity ID or opportunity number is required."]` | Prevented by schema `min(1)` |
| Non-numeric id / `{}` | 200 | `data.message: "No response received, as the webservice at the backend server … is not available."` | Prevented by schema. The same message on a numeric id is treated as `upstream_unavailable` (transient). |
| Malformed JSON body | 502 | `{"message":"Internal server error"}` | Server bug by construction. Classified `upstream_unavailable` because a genuine gateway 502 looks identical. |
| Wrong method or path | 403 | `{"message":"Missing Authentication Token"}` | `upstream_route_unavailable` |

The fetch runs at a plain-fetch boundary with a per-method accept-list, not a helper that throws on every non-2xx. For `fetchOpportunity`, the accepted statuses are `200` (parse the body and classify it as found / not_found / backend-unavailable) and `404` (`not_found`). Every other status goes through `httpErrorFromResponse` (429 → `RateLimited`, 5xx → `ServiceUnavailable`), with 403 mapped to `upstream_route_unavailable` first. A not-found is a result, never thrown.

#### Output

```ts
output: z.object({
  opportunities: z.array(OpportunityRecord).describe('Records found, in input order.'),
  unresolved: z.array(z.object({
    input: z.string().describe('The id or number as given.'),
    input_kind: z.enum(['opportunity_id','opportunity_number']).describe('Which list it came from.'),
    outcome: z.enum(['not_found','ambiguous']).describe('not_found = no record; ambiguous = the number matches more than one opportunity.'),
    candidates: z.array(z.object({
      opportunity_id, opportunity_number, title, agency_code, status, open_date?,
    })).optional().describe('For ambiguous numbers: every match, to re-request by id.'),
    guidance: z.string().describe('The next call to make.'),
  })).describe('Inputs that did not resolve to exactly one record. Empty when all resolved.'),
})
```

`OpportunityRecord` (flat where possible; every numeric field carries its unit):

Source paths are relative to `fetchOpportunity`'s `data`. **`{block}` is `synopsis` when `data.docType` is `synopsis`, else `forecast`.** Money, eligibility, codes, contact, description, and link fields live only inside that block, never at the `data` root; a posted record also keeps a stale `forecast` block, which is never read.

| Field | Type | Source | Notes |
|:------|:-----|:------------------------------------|:------|
| `opportunity_id` | int | `id` | |
| `opportunity_number` | string | `opportunityNumber` | |
| `title` | string | `opportunityTitle` | Entities decoded. |
| `status` | enum | `ost` lowercased | `POSTED` → `posted`, etc. |
| `doc_type` | enum | `docType` | `synopsis` \| `forecast` |
| `category_code` / `category_label` | string? | `opportunityCategory.category` / `.description` | D Discretionary, M Mandatory, C Continuation, E Earmark, O Other. |
| `agency_code` / `agency_name` | string | `agencyDetails.agencyCode` / `.agencyName` (root) | Fallback `owningAgencyCode`. |
| `top_agency_code` / `top_agency_name` | string? | `topAgencyDetails.agencyCode` / `.agencyName` (root) | |
| `grants_gov_url` | string | built | `https://www.grants.gov/search-results-detail/{id}` |
| `close_date` | string? | `synopsis.responseDateStr` or `forecast.estApplicationResponseDateStr` | `YYYY-MM-DD` from the `…Str` field (`2026-10-19-00-00-00`). The midnight time is an artifact and is dropped. |
| `close_date_kind` | enum | derived | Same rule as search. Forecast close dates are estimates, which `close_date_is_estimate: true` signals. |
| `close_date_is_estimate` | boolean | derived | `true` for forecasts. |
| `days_until_close` | int? | derived | Only when `fixed`. |
| `close_date_explanation` | string? | `synopsis.responseDateDesc` / `forecast.estApplicationResponseDateDesc` | Text-normalized, then trimmed. The literal string `"undefined"` (DOS 355211) and `""` → absent. Often the submission time rule (`…no later than 11:59 p.m., ET, on the listed application due date`). |
| `original_close_date` | string? | `originalDueDate` (root) | Parsed from `"Oct 19, 2026 12:00:00 AM EDT"` to `YYYY-MM-DD`. Shown only when it differs from `close_date` (NSF 21-595: 2021-10-15 vs 2026-10-14). |
| `posted_date` | string? | `{block}.postingDateStr` | |
| `archive_date` | string? | `{block}.archiveDateStr` | Absent on NSF rolling records and on posted records with no close date. |
| `last_updated` | string? | `{block}.lastUpdatedDate` | Parsed from `"Sep 18, 2026 02:07:27 PM EDT"` to `YYYY-MM-DD`. |
| `past_revision_count` | int | `synopsisHistCount + forecastHistCount` (root) | History itself is dropped (NSF 21-595: 713 KB of 733 KB is `opportunityHistoryDetails`, 43 revisions). |
| `money_source` | enum | derived | `synopsis` \| `forecast`, naming `{block}`. A posted record can carry a stale `forecast` block with different numbers (HRSA-27-005: synopsis ceiling 10,116,100 vs forecast 19,182,000). |
| `award_ceiling_usd` / `award_floor_usd` | number? | `{block}.awardCeiling` / `{block}.awardFloor` | Strings upstream. `"none"`, `""`, `null`, missing → absent (PAR-25-144, NSF 26-523). `"0"` is kept as `0` and rendered `$0 (as listed)`: DOD records list 0 alongside a real funding total. The `…Formatted` twins are ignored. |
| `estimated_total_funding_usd` | number? | `{block}.estimatedFunding` | Same parsing. |
| `expected_awards` | int? | `{block}.numberOfAwards` | String upstream (`"63"`); missing on NSF 26-523 → absent. |
| `cost_sharing_required` | boolean? | `{block}.costSharing` | Absent when not a boolean. |
| `forecast_estimates` | object? | forecast only: `forecast.estSynopsisPostingDateStr`, `.estApplicationResponseDateStr`, `.estAwardDateStr`, `.estProjectStartDateStr`, `.fiscalYear` (integer) | `{ est_post_date?, est_close_date?, est_award_date?, est_project_start_date?, fiscal_year? }` |
| `applicant_types` | `{code,label}[]` | `{block}.applicantTypes[].id` / `.description` | Never shown without the narrative; see `eligibility_narrative`. |
| `eligibility_narrative` | string? | `{block}.applicantEligibilityDesc` | Text-normalized, capped at 6,000 chars (`eligibility_narrative_truncated`). Absent on some records (HRSA-27-005). Often plain text with literal `\n` lists (NSF 21-595) and bare entities (`&ldquo;` on DOD 356612). When absent, `format()` says `No additional eligibility text listed; see the attachments.` |
| `funding_instruments` | `{code,label}[]` | `{block}.fundingInstruments[].id` / `.description` | |
| `funding_categories` | `{code,label}[]` | `{block}.fundingActivityCategories[].id` / `.description` | |
| `funding_category_explanation` | string? | `{block}.fundingActivityCategoryDesc` | The text the `O` ("Other … see text field") category label points to. Text-normalized, capped at 2,000 chars. Absent on most records (present on DOD 356612). |
| `assistance_listings` | `{number, program_title?}[]` | `cfdas[].cfdaNumber` / `.programTitle` (root) | |
| `description` | string? | `synopsis.synopsisDesc` / `forecast.forecastDesc` | Text-normalized, capped at 12,000 chars (`description_truncated`). Probed max 10,345 chars (NSF 21-595). HTML on most agencies, plain text with literal newlines on DOS. |
| `agency_contact` | object? | `{block}.agencyContactName`, `.agencyContactEmail`, `.agencyContactPhone`, `.agencyContactDesc` (synopsis only), `.agencyContactEmailDesc` | `{ name?, email?, phone?, details? }`. Published applicant-facing contact. Copied, never invented. `name` can hold a newline (`"samuel D Jensen\nGrantor"`), so it is an inline slot under [Untrusted text handling](#untrusted-text-handling). |
| `additional_info_url` / `additional_info_label` | string? | `synopsis.fundingDescLinkUrl` / `synopsis.fundingDescLinkDesc` | |
| `attachments` | array | `synopsisAttachmentFolders[]` (root) → `.synopsisAttachments[]` | `{ attachment_id: id, folder_type: folder.folderType, file_name: fileName, description?: fileDescription, mime_type: mimeType, size_in_bytes: fileLobSize, download_url }`. `download_url` = `https://apply07.grants.gov/grantsws/rest/opportunity/att/download/{id}` (keyless, confirmed 200 `application/pdf` with a `Content-Disposition` filename). Capped at 30, with `attachment_count` holding the full count. |
| `application_packages` | array | `opportunityPkgs[]` (root) | `{ package_id: packageId (e.g. PKG00294168), competition_id?: competitionId, competition_title?: competitionTitle, opening_date?: openingDate, closing_date?: closingDate, electronic_required?: electronicRequired }` (dates already `YYYY-MM-DD`; `electronicRequired` `"Y"`/`"N"` → boolean). Capped at 10 (`application_package_count`). The required-forms list is not in the API. |
| `closed_package_count` | int | `closedOpportunityPkgs.length` (root) | Count only (DOD 356612 carries 25). |
| `related_opportunities` | array | `relatedOpps[]` (root) | `{ opportunity_id: opportunityId, opportunity_number: opportunityNum, title: opportunityTitle, agency_code: agencyCode, posted_date?: postedDate, close_date?: closeDate, note?: comments }`. Dates arrive as `"Mar 20, 2015"` (no time) and are parsed to `YYYY-MM-DD`. Capped at 10. |

`synopsisDocumentURLs` was empty on every sampled record (12 records across 8 agencies). Its item shape is unverified, so v1 does not surface it; see [Known Limitations](#known-limitations).

#### Enrichment

```ts
enrichment: {
  notice: z.string().optional().describe('Summary of unresolved inputs and what to call next.'),
},
```

This block has no required field, so nothing needs to be written unconditionally. `notice` is set only when `unresolved` is non-empty. The batch has no cap-like input (the lists are schema-bounded at 5 and all are returned), so no truncation fields apply.

#### Outcome states

| State | Result |
|:------|:-------|
| All resolved | `opportunities` in input order, `unresolved: []`. |
| Partial | `opportunities` + `unresolved` + `notice`. The framework's partial-success telemetry keys on a `failed` array. This tool's misses are results, not failures, so the field is named `unresolved` on purpose. |
| None resolved | `opportunities: []`, `unresolved` filled. **Not thrown.** |
| Number ambiguous | `outcome: 'ambiguous'` with `candidates` (no record fetched for it). Guidance: `Opportunity number "{n}" matches {k} opportunities; call grantsgov_get_opportunity with opportunity_ids set to the one you want.` |
| Number not found | Guidance: `No opportunity numbered "{n}" in any status. Check the exact spelling and punctuation, or call grantsgov_search_opportunities with keyword "\"{n}\"" (quoted) and statuses all four to find it by full text.` |
| Id not found | Guidance: `No opportunity with id {id}. Ids come from grantsgov_search_opportunities rows (opportunity_id); search there to find the record.` |
| Upstream failure on one item | The whole call throws `upstream_unavailable`. A transient backend outage is not a per-record fact, and a partial answer would misreport which records exist. |

#### Error contract

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `no_identifiers` | `ValidationError` | Both lists empty or unset. | `Pass opportunity_ids from grantsgov_search_opportunities rows, or opportunity_numbers such as HRSA-27-005.` |
| `too_many_identifiers` | `ValidationError` | More than 5 combined after de-duplication. | `Request at most 5 opportunities per call; split the list across several grantsgov_get_opportunity calls.` |
| `upstream_unavailable` | `ServiceUnavailable`, `retryable: true`, `thrownBy: 'service'` | As in search. | `Grants.gov is not responding; wait a minute and call grantsgov_get_opportunity again.` |
| `upstream_route_unavailable` | `ServiceUnavailable`, `retryable: false`, `thrownBy: 'service'` | As in search. | `The Grants.gov detail API route is not answering; the legacy API may have been retired, so report this to the server maintainer.` |

### `grantsgov_list_reference`

**Description (draft):** `List the codes Grants.gov search filters accept, with labels and live opportunity counts: agencies (top level, or one agency's sub-agencies via parent_code, or matched by name via name_contains), applicant eligibility types, funding categories, funding instruments, statuses, sort options, and keyword syntax. Use the codes as grantsgov_search_opportunities inputs.`

#### Params

| Param | Type | Notes |
|:------|:-----|:------|
| `topic` | `z.enum(['agencies','eligibilities','funding_categories','funding_instruments','statuses','sort_options','keyword_syntax'])` | Required. |
| `name_contains` | `optionalText(z.string().max(100))` | Local filter. Strict token match over label and code: normalize (lowercase, NFKD, strip diacritics and punctuation), every token must appear. For `agencies` it searches all 712 codes (top-level and sub-agencies) and ignores the top-level-only default. Applies to every topic. |
| `parent_code` | `optionalText(z.preprocess(normalizeAgencyCode, z.string().regex(AGENCY_CODE)))` | `agencies` only: list every code under this one (`HHS` → its 58 sub-agencies; `DOD-DARPA` → its offices). Any other topic → `filter_not_applicable`. Unknown → `unknown_parent_code`. |

#### Data source

The service holds a **reference snapshot** built from two facets-only `search2` calls in parallel, cached in-process for 24 h with a single in-flight promise:

- `{ rows: 0, oppStatuses: 'forecasted|posted|closed|archived' }`: the full vocabulary (46 top-level agencies, 681 sub-agencies, 17 eligibility codes, 28 funding categories, 4 instruments) and `total_count` per code.
- `{ rows: 0 }`: default scope, giving `open_count` (forecasted + posted) per code.

Codes appear only if at least one opportunity carries them, which is what makes the snapshot a valid allowlist for search input validation. Agency hierarchy comes from `subAgencyOptions` plus hyphen prefixes. `subAgencyOptions` is flat: it lists every descendant of a top-level agency, not just its children (`DOT` lists `DOT-FAA-FAA COE-AJFE`). A code's parent is the longest other code `P` such that the code is `P`, then optional spaces, then `-`, then more (`DOT-FAA-FAA COE-AJFE` → `DOT-FAA-FAA COE`; `DOT-FTA - TPM` → `DOT-FTA`), else its top-level agency. Some parents list themselves as a sub-entry (`DOC`, `DOD`, `DOE`, `DOS`, `DOT`, `NASA`); the snapshot folds that entry into the parent row, which leaves 712 unique codes. Labels are trimmed. The snapshot also keeps each code's full descendant list, which [agency code encoding](#agency-code-encoding) reads.

Static topics (`statuses`, `sort_options`, `keyword_syntax`) need no upstream call. `statuses` still reads the snapshot for counts.

#### Output

```ts
output: z.object({
  topic: z.enum([...]).describe('The topic listed.'),
  entries: z.array(z.object({
    code: z.string().describe('Value to pass to the matching grantsgov_search_opportunities input.'),
    label: z.string().describe('Human-readable name.'),
    parent_code: z.string().optional().describe('agencies only: the parent agency code.'),
    has_children: z.boolean().optional().describe('agencies only: true when the code has sub-agencies (searching it includes them).'),
    open_count: z.number().optional().describe('Forecasted + posted opportunities with this code.'),
    total_count: z.number().optional().describe('Opportunities with this code across all statuses.'),
    description: z.string().optional().describe('Usage notes for statuses, sort_options, and keyword_syntax entries.'),
  })).describe('Reference entries.'),
  snapshot_date: z.string().optional().describe('When the live vocabulary was fetched (ISO timestamp); absent for fully static topics.'),
})
```

Static entries: `statuses` (four, with descriptions and counts: forecasted = announced ahead of posting, estimated dates; posted = open for applications; closed = past the close date, awaiting archive; archived = past the archive date). `sort_options` (the nine sort enum values, each with a description and whether it needs a keyword). `keyword_syntax` (entries: `term`, `"phrase"`, `AND`, `OR`, `NOT` / `-term`, `( … )`, `term*`, each with a real example and the count-free explanation, plus a note that bare terms are ANDed and that tokens with internal `-`/`.` are matched as phrases).

#### Enrichment

```ts
enrichment: {
  totalCount: z.number().describe('Entries returned.'),
  notice: z.string().optional().describe('Guidance when name_contains matched nothing.'),
},
```

`totalCount` is written first, before the static/live branch (`ctx.enrich.total(0)`), then overwritten with `ctx.enrich.total(entries.length)` after filtering. Entry lists are bounded (largest: `name_contains` over agencies ≤ 712; `parent_code: DOS` = 218 after folding the self-entry), and the tool has no cap input, so no truncation fields.

Zero-match notice: `No {topic} entry matched "{name_contains}". Try a shorter name or a single distinctive word, or call grantsgov_list_reference with topic {topic} and no name_contains to browse the full list.`

#### Error contract

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `unknown_parent_code` | `NotFound` | `parent_code` is not a known agency code. | `Call grantsgov_list_reference with topic agencies and name_contains set to the agency name to find its code.` |
| `filter_not_applicable` | `ValidationError` | `parent_code` given with a topic other than `agencies`. | `Remove parent_code, or call grantsgov_list_reference with topic agencies to list sub-agencies.` |
| `upstream_unavailable` | `ServiceUnavailable`, `retryable: true`, `thrownBy: 'service'` | The snapshot fetch failed after retries and no cached snapshot exists. | `Grants.gov is not responding; wait a minute and call grantsgov_list_reference again.` |
| `upstream_route_unavailable` | `ServiceUnavailable`, `retryable: false`, `thrownBy: 'service'` | As above. | `The Grants.gov search API route is not answering; the legacy API may have been retired, so report this to the server maintainer.` |

A stale snapshot is served when a refresh fails and a previous snapshot exists. `snapshot_date` shows its age.

---

## Untrusted text handling

Titles, descriptions, eligibility narratives, close-date explanations, category explanations, agency names, contact blocks, attachment names and descriptions, package titles, related-opportunity notes, and facet/reference labels are authored by agencies. They are data, never instructions.

| Stage | Rule |
|:------|:-----|
| Service text normalization (both surfaces) | Applied to `synopsisDesc`, `forecastDesc`, `applicantEligibilityDesc`, `fundingActivityCategoryDesc`, and `responseDateDesc`/`estApplicationResponseDateDesc`. These fields arrive either as HTML or as plain text with literal `\n` line structure and bare entities (DOS descriptions, NSF and DOD eligibility text), so the converter never treats input as whitespace-insensitive HTML: source newlines are kept, and tags only add breaks. Handled tags: `p`, `div`, `br` → line breaks; `li` → `- ` bullets (`ol` numbered); `strong`/`b`/`em`/`i`/`sup`/`span` → inner text; `a href` → `text (url)`; everything else stripped. HTML entities decoded (named table covering `&nbsp; &amp; &quot; &lt; &gt; &ldquo; &rdquo; &lsquo; &rsquo; &ndash; &mdash; &hellip;` plus numeric `&#…;`/`&#x…;`; unknown named entities left as-is). Titles (search and detail) are entity-decoded only (56 of 940 posted titles carry entities, e.g. `&rsquo;`). Runs of 3+ newlines collapse to one blank line; each line is right-trimmed. This normalized text is the canonical value in `structuredContent`, which otherwise stays verbatim: no CR/LF flattening and no markdown escaping. |
| `format()` inline slots | Any upstream string placed inside a line (title, agency name, facet or reference label, file name, package title, related-opportunity note, close-date explanation in a table cell, contact name) has CR/LF/CRLF flattened to one space: `.replace(/\r\n\|\r\|\n/g, ' ')`. Inside a markdown table cell, `\|` is also escaped as `\\|` so agency text cannot split the row. |
| `format()` multi-line fields | `description`, `eligibility_narrative`, `funding_category_explanation`, `close_date_explanation` (when rendered as a block), `agency_contact.details`: split on `/\r\n\|\r\|\n/`, and each line is prefixed with `> ` (blank lines as `>`). This keeps agency text visibly quoted and keeps it from forging headings or tool-like structure in the rendered markdown. |
| URLs | Attachment `download_url` is built by the server from a numeric id. `additional_info_url` and the links extracted from `a href` are upstream strings: rendered as text, never fetched by the server. |

The text normalizer is ~50 lines in the service layer (`html-to-text.ts`) with no dependency. The markup is simple: a survey of 6 records found only `p ul ol li a strong span br sup div` and ten entity forms.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `GrantsGovService` (`src/services/grants-gov/grants-gov-service.ts`) | `POST https://api.grants.gov/v1/api/search2`, `POST https://api.grants.gov/v1/api/fetchOpportunity` | all three tools |

Supporting modules in `src/services/grants-gov/`: `types.ts` (raw upstream shapes, all fields optional/nullable), `keyword.ts` (`compileKeyword`), `normalize.ts` (dates, money, close-date kind, ET "today", entity decoding), `html-to-text.ts`, `reference.ts` (snapshot build and agency tree).

Methods:

| Method | Upstream | Returns |
|:-------|:---------|:--------|
| `search(body: Search2Body, ctx)` | 1× `search2` | `{ hitCount, hits: RawHit[], facets: RawFacets }` |
| `scanClosingWindow(body, cutoffDate, ctx)` | 1–4× `search2` (sequential pages of 500) | `{ windowHits, postedTotal, nextCloseAfterWindow?, ceilingHit }` |
| `resolveNumber(number, ctx)` | 1–2× `search2` (`oppNum` double-quoted, all statuses; uppercase retry) | `{ kind: 'unique', id } \| { kind: 'ambiguous', candidates } \| { kind: 'not_found' }` |
| `fetchOpportunity(id, ctx)` | 1× `fetchOpportunity` | `{ kind: 'found', record: RawDetail } \| { kind: 'not_found' }` (history stripped before return) |
| `getReference(ctx)` | 2× `search2` (`rows: 0`), cached 24 h | `ReferenceSnapshot` |

`Search2Body` is a closed interface with exactly `keyword`, `oppNum`, `cfda`, `agencies`, `eligibilities`, `fundingCategories`, `fundingInstruments`, `oppStatuses`, `dateRange`, `sortBy`, `rows`, `startRecordNum`, all multi-values pre-joined with `|`. `oppNum` arrives already double-quoted and `agencies` already encoded (quoting and subtree expansion), both built by one function each in the service so no caller path can send the raw form. No index signature, no spread of caller input.

### Resilience

| Concern | Decision |
|:--------|:---------|
| Transport | A plain `fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal })` in one private `post()` helper. `signal` is `AbortSignal.any([attempt.signal, perAttempt])`, where `perAttempt` is an `AbortController` + `setTimeout(Math.min(15_000, remainingMs))` cleared in `finally` (never `AbortSignal.timeout()`, per the framework's Bun realm note). The destination is fixed, and no caller-supplied URL reaches it, so the SSRF guard in `fetchWithTimeout` buys nothing here. The throw-on-non-2xx helper is deliberately not used. |
| Status accept-list | Per method: `search2` accepts `{200}`; `fetchOpportunity` accepts `{200, 404}`, with a 404 read as `not_found` in case the upstream ever moves a miss out of band (today a miss is a 200 skeleton). An accepted status is parsed and classified. A non-accepted status is never parsed as data: `403` → `upstream_route_unavailable` (non-retryable); anything else → `httpErrorFromResponse(response, { service: 'Grants.gov' })` (5xx → `ServiceUnavailable`, 429 → `RateLimited` with `Retry-After`). |
| Body classification | Non-JSON or HTML body → `serviceUnavailable` (transient). `errorcode !== 0` → `serviceUnavailable`. `fetchOpportunity` with `data.message` matching `/not available/i` → `serviceUnavailable` (transient). `data.id == null` with a "no record found" `errorMessages` entry → `not_found`. `search2` answers an unparseable parameter with a 200 skeleton that has no `searchParams` (array `oppStatuses`, `dateRange: "abc"`); schemas prevent every such input, so the parser treats `searchParams` as optional and never classifies on it. |
| Reason propagation | Every service throw carries its contract reason and the calling tool's hint: `serviceUnavailable(msg, { reason: 'upstream_unavailable', ...ctx.recoveryFor('upstream_unavailable') })`, and `httpErrorFromResponse(response, { service: 'Grants.gov', data: { reason, ...ctx.recoveryFor(reason) } })` for 5xx. The reason names are shared across the three tools and each tool's contract supplies its own recovery string, so the service stays tool-agnostic while each hint names the right tool to re-call. |
| Retry boundary | `withRetry` wraps fetch + parse + body classification per upstream call: `maxRetries: 2`, `baseDelayMs: 500` (observed latency 0.25–1.2 s), `deadlineMs: 25_000`, threading `attempt.signal` and `remainingMs` into the fetch. |
| Pacing | No published limit. One `createPacer({ name: 'grants-gov', maxConcurrent: 4 })` fronts every upstream call, so a 5-item get or a burst of agent calls never opens more than 4 concurrent requests from this process. `withRetry` sits outside the pacer, so each attempt re-queues. Disposed in `createApp({ teardown })`. |
| Fan-out | `grantsgov_get_opportunity` resolves numbers, then fetches records with `Promise.all` through the pacer (≤ 5). One failure throws the whole call (see Outcome states). |
| Reference cache | Module-level `{ snapshot, fetchedAt, inflight }`. Refresh when older than 24 h. A failed refresh with a previous snapshot serves the stale one and logs a warning. Process-local, not tenant-scoped (public vocabulary). No `ctx.state`. |
| Cancellation | `ctx.signal` threads into `withRetry`; the closing-window scan checks `ctx.signal.aborted` between pages. |

### Response-size budget

Measured raw upstream sizes and the curated output estimate:

| Call | Raw upstream | Tool output (estimate) | Control |
|:-----|:-------------|:-----------------------|:--------|
| Search, 25 rows + facets | 26.7 KB | ~7 KB rows + ~4 KB facets | `limit` ≤ 100; `include_facets: false` for paging |
| Search, 100 rows + facets | ~60 KB | ~30 KB | cap 100 |
| Closing scan (internal) | up to 4 × ~165 KB (500 rows) | same as a search page | server-side only; not returned |
| Get, 1 typical record | 5–54 KB (history stripped) | 3–15 KB | description ≤ 12,000 chars; narrative ≤ 6,000 |
| Get, 1 worst record (NSF 21-595) | 733 KB → ~19.5 KB after history strip | ~18 KB | history dropped, count kept |
| Get, 5 records | — | typical 15–60 KB, ceiling ~110 KB | batch ≤ 5; per-record caps; attachments ≤ 30, packages ≤ 10, related ≤ 10 |
| Reference, agencies top level | 58 KB (full facets) | ~4 KB (46 entries) | top level by default |
| Reference, `parent_code: DOS` | — | ~18 KB (218 entries) | bounded vocabulary |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| — | — | None. The API is keyless, and the base URLs are fixed constants in the service. |

No server-specific `server-config.ts` is needed. `server.json` / `manifest.json` / plugin manifests declare no user config.

---

## Server Instructions

```text
Find federal funding with grantsgov_search_opportunities, then read full records (award range, eligibility narrative, attachments) with grantsgov_get_opportunity using the opportunity_id from each row. Search returns forecasted and posted opportunities unless statuses says otherwise; filter codes for agencies, applicant eligibility, and funding categories come from grantsgov_list_reference. Each record carries its assistance listing number (ALN) and opportunity number, the keys other federal spending and research-funding sources use.
```

---

## Workflow Analysis

`grantsgov_get_opportunity` with 2 numbers + 1 id (worst common case):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `search2` `{ oppNum, oppStatuses: all four, rows: 10 }` × 2 (parallel, paced) | Resolve each number → id, detect ambiguity |
| 1b | `search2` uppercased retry, only on miss with lowercase input | Case recovery |
| 2 | `fetchOpportunity` × 3 (parallel, paced) | Full records |

`grantsgov_search_opportunities` with `agencies` + `eligibilities` + `closing_within_days`:

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `getReference` (cached; 2× `search2 rows:0` on a cold cache) | Validate and expand agency codes and eligibility codes |
| 2 | `search2` pages of 500, `closeDate\|asc` (usually 1 page) | Window scan |

---

## Known Limitations

- **Legacy API retirement.** Neither Grants.gov nor the Simpler.Grants.gov wiki marks `search2`/`fetchOpportunity` deprecated as of the idea-stage probe, but Simpler.Grants.gov is now the default web experience. A retired route surfaces as `upstream_route_unavailable`, and all upstream access sits behind `GrantsGovService` (see Decisions Log).
- **No close-date filter upstream.** `closing_within_days` is a server-side scan, bounded at 2,000 rows. It covers posted records only: search rows for forecasts carry no close date, so a forecast's estimated deadline is visible only on its `grantsgov_get_opportunity` record.
- **No award-amount or cost-sharing filters.** The legacy search has none. Amounts come from `grantsgov_get_opportunity`.
- **Multi-ALN and multi-number search not supported upstream.** `cfda` and `oppNum` take one value each.
- **Required forms are not in the API.** `opportunityPkgs` gives package metadata only. The forms usually live in the NOFO attachment, which v1 links to and does not parse.
- **`synopsisDocumentURLs` shape unverified.** It was empty on every sampled record, so it is not surfaced.
- **Placeholder close dates are inferred.** The ≥ 25-years-out rule is transparent and documented, and the listed date is always kept alongside the kind.
- **Keyword relevance ranking** is the upstream's own. The score is not exposed.

---

## API Reference

**Base:** `https://api.grants.gov/v1/api`, JSON over `POST`, keyless. `GET` or an unknown path → `403 {"message":"Missing Authentication Token"}`. Malformed JSON or a form body → `502 {"message":"Internal server error"}`. Every 200 carries `{ errorcode: 0, msg: "Webservice Succeeds", token, data }`, including in-band failures. `token` is a per-response JWT and is ignored.

### Probe log (2026-09-24)

| Endpoint / param | Probe | Finding |
|:-----------------|:------|:--------|
| `search2` `{}` | default | 200, 0.59 s, 26.7 KB. `hitCount` 1,531 (forecasted 591 + posted 940). Hit keys: `id` (digit string), `number`, `title`, `agencyCode`, `agency`, `openDate`/`closeDate` (`MM/DD/YYYY` or `""`), `oppStatus`, `docType`, `cfdaList[]`. `data.searchParams` echoes applied params. |
| `search2` `{rows:0, oppStatuses: all four}` | facets-only | 83,451 total. 17 eligibility codes, 28 categories, 4 instruments, 46 top-level agencies, 681 sub-agencies. |
| `oppStatuses` | array `["posted"]` | 0 hits, `searchParams.oppStatuses: null`: array form unsupported. |
| `oppStatuses` | `"posted,forecasted"` / `"open"` / `""` / `"Posted"` / `"posted\|bogus"` | 0 / 0 / default scope / 940 / 940. Pipe string only; case-insensitive; unknown members ignored. |
| unknown key | `{"foo":"bar"}` | Ignored → default scope (1,531). |
| `aln` vs `cfda` | `93.866` | `aln` ignored (1,531); `cfda` → 136. `cfda` accepts `93866` and lowercase alpha (`93.ech`). Pipe-joined multi → 0. Alphanumeric ALNs exist (`93.ECH`, `93.00L`). |
| `agencies` | `HHS` / `HHS*` / `HHS\|HHS-*` / `hhs` / `HHS-NIH11` / `hhs-nih11` / `DOE` / `NSF\|DOE` / `XYZ` | 0 / 940 / (all-status 23,899 = `HHS*`) / 0 / 697 / 0 / 0 open (1 archived) / 124 / 0. Bare code = exact match; `-*` suffix wildcard works at every level (`HHS-CDC\|HHS-CDC-*` 3,920 vs `HHS-CDC` 1,728 all-status). Whitespace trimmed upstream. No top-level code is a non-hyphen prefix of another code, but 27 codes below the top are (`USDA-FS` → `USDA-FSA`/`USDA-FSIS`: `USDA-FS*` 190 vs `USDA-FS\|USDA-FS-*` 145). |
| `agencies`, codes with spaces | `DOT-FAA-FAA COE` / `"DOT-FAA-FAA COE"` / `DOT-FTA - TPM` / `"DOT-FTA - TPM"` / `DOT-FTA` / quoted subtree list (5 codes) / `DOT-FAA-FAA?COE\|DOT-FAA-FAA?COE-*` | All-status: 0 / 4 / 197 (= `DOT-FTA`, wrong) / 2 / 197 / 9 / 9. The value is query-parsed: unquoted spaces split the code into terms. Ten of 712 codes contain spaces, all under `DOT`. `subAgencyOptions` is flat (every descendant, not only children). |
| `sortBy` | `openDate\|desc`, `closeDate\|asc`, `oppNum\|asc`, `agency\|asc`, `openDate\|DESC` | Work (direction case-insensitive). `oppTitle\|asc`, `title\|asc`, `relevance`, `relevance\|desc`, `score\|desc`, `openDate` (no direction), `OPENDATE\|DESC` → 0. |
| `closeDate\|asc` + `posted` | `rows:1000` | Monotonic; first row = today ET; 77 blanks last; 12 × `01/01/2099` (DOS), 13 × 2076 (NSF, "Proposals accepted anytime"), DOD 2034/2043/2044. |
| `oppNum` | `HRSA-27-005` / lowercase / padded / `HRSA-27` / `"A\|B"` / `"1"` | 1 / 0 / 1 / 0 / 0 / 6 hits incl. one non-equal number. Exact, case-sensitive, single-value, not unique. |
| `oppNum`, query syntax | `PAR-25-14*` / `"PAR-25-14*"` (quoted) / `PAS-TUNIS- APS FY2026` / same quoted / `"HRSA-27-005"` / `"1"` | 8 (wildcard) / 0 / 0 / 1 / 1 / 6 (same non-equal hit). Query-parsed like `agencies`; quoting makes it literal. Numbers with spaces exist (1 in 5,000 sampled). |
| `keyword` | see [Keyword compilation](#keyword-compilation) | Implicit OR; `AND`/`OR`/`NOT`/`-`/parens/quotes/`*` honored; lowercase operators are terms; dangling operator widens; hyphen/period tokens split; `?`/`~`/`:`/ranges have Lucene meanings. |
| `eligibilities` | `12` / `12\|07` / `7` / `XX` / `12\|XX` | 883 / 944 / 0 / 0 / 883. OR within, AND across facets (`12` + `HL` → 758). Zero-padded only. |
| `fundingCategories`, `fundingInstruments` | `HL`, `hl`, `G`, `g`, `G\|CA` | 886, 0, 1,023, 0, 1,504. Case-sensitive. |
| `dateRange` | `"7"`, `7`, `"0"`, `"-3"`, `"abc"`, `"365"` | 38, 38, 0, 0, 0, 827. **With `closed` or `archived` in `oppStatuses`, the status filter is replaced**: `archived` + 365 → 827 forecasted+posted rows; `closed` + 365 → 466 posted rows. |
| `startRecordNum` | 3, 1530, 5000 | Offsets work; past end → 0 rows, true `hitCount`. |
| `rows` | `-1`, `"5"` | 0, 5 (string coerced). |
| Facet scoping | `agencies:"HHS\|HHS-*"` + keyword `opioid` | `agencies` facet narrows to HHS with its sub-agency breakdown; `oppStatusOptions` counts all four statuses regardless of the status filter. On zero hits the other facets are empty, but `oppStatusOptions` still counts the other statuses (`tuberculosis AND tribal AND museum`: 0 open, closed 1, archived 14), which the zero-hit notice reads. |
| `fetchOpportunity` | `363423` / `"363423"` | 200, 0.42 s, 54 KB. String id accepted. |
| `fetchOpportunity` | `999999999` | 200, `data.id: null`, `errorMessages: ["There is no record found for your search."]`. |
| `fetchOpportunity` | `0` / `"HRSA-27-005"` / `{}` | `errorMsgs: ["Opportunity ID or opportunity number is required."]` / backend "not available" message / same. |
| `fetchOpportunity` | `334326` (NSF 21-595) | 733 KB, 1.14 s; 713 KB is `opportunityHistoryDetails` (43 revisions). |
| `fetchOpportunity` | `363917` (forecast) | `forecast` block only; `est…Date`/`…Str` fields, `fiscalYear`; no attachments/packages. |
| `fetchOpportunity` | `363621`, `347679` (NSF) | `awardCeiling: "none"`, `numberOfAwards: null`, `archiveDate: null`, `responseDateDesc: "Proposals accepted anytime"` with a 2076 date. |
| `fetchOpportunity` | `355211` (DOS) | `responseDateDesc: "undefined"` (literal string), `01/01/2099` close. |
| `fetchOpportunity` | `356612` (DOD) | `awardCeiling: "0"`, 1 `relatedOpps` entry (`opportunityId`, `opportunityNum`, `opportunityTitle`, `agencyCode`, `postedDate`, `closeDate`), 25 `closedOpportunityPkgs`. |
| attachment download | `GET apply07.grants.gov/…/att/download/355067` (HEAD) | 200, `application/pdf`, `Content-disposition: attachment; filename="hrsa-27-005_full announcement.pdf"`. |
| error shapes | malformed JSON / GET / form body / bad path | 502 / 403 / 502 / 403, JSON `message` bodies. |
| keyword length | 3,000-char keyword | 200, handled. Schema caps at 500. |
| search forecasts | 5,000 rows, forecasted+posted+closed | 548 of 548 forecast rows have `closeDate: ""`. 7,261 ALNs all match `^\d{2}\.[0-9A-Z]{3}$`. |
| `search2` other | `dateRangeOptions` facet; `startRecordNum: 83000` all-status | Facet lists the 3–56-day posted windows with counts (unused). Deep offsets work. |
| `fetchOpportunity` field paths | `363423`, `363917`, `363621`, `355211`, `356612`, `334326` | Money, contact, `applicantTypes`, `fundingInstruments`, `fundingActivityCategories`, `applicantEligibilityDesc`, `fundingActivityCategoryDesc`, `fundingDescLink*` live under `synopsis`/`forecast`, not the `data` root. `agencyDetails`/`topAgencyDetails`, `cfdas`, attachments, packages, `relatedOpps`, `originalDueDate`, `ost`, `docType`, history counts are root. |
| `fetchOpportunity` | `-5` / `2147483648` / `99999999999999` | 502 after ~10 s / not-found skeleton / not-found skeleton. |

---

## Implementation Order

1. **Server setup.** Replace the echo definitions in `src/index.ts`. The `createApp()` identity block is exactly `name: 'grantsgov-mcp-server'` and `title: 'grantsgov-mcp-server'`, bare and hyphenated, with no other identity fields. Add `instructions` (above) and `teardown` (dispose the pacer). Delete the echo tool, app tool, resources, prompt, and their tests (`tests/tools/`, `tests/resources/`, `tests/prompts/`, `tests/fuzz/echo-tool.fuzz.test.ts`, `tests/integration/echo-contract.int.test.ts`); repoint `tests/smoke/definitions.smoke.test.ts` at the new definitions.
2. **Service primitives, pure and unit-tested first:** `normalize.ts` (ET today, `MM/DD/YYYY` and `…Str` and `"Oct 19, 2026 12:00:00 AM EDT"` date parsing, money parsing, close-date kind), `html-to-text.ts`, `keyword.ts`.
3. **`GrantsGovService` transport:** request helper (accept-list, body classification, retry, pacer), then `search`, `getReference` (snapshot + agency tree), `fetchOpportunity`, `resolveNumber`, `scanClosingWindow`.
4. **`grantsgov_list_reference`**. It grounds field-testing for the rest.
5. **`grantsgov_search_opportunities`**.
6. **`grantsgov_get_opportunity`**.
7. Create the `src/mcp-server/tools/definitions/index.ts` barrel (the scaffold registers inline in `src/index.ts` and has none) and pass it to `createApp({ tools })`. No resources, no prompts.

Each step is independently testable.

---

## Test Boundary

| Layer | What is tested | How |
|:------|:---------------|:--------|
| Pure functions | `compileKeyword` (every row of the keyword trap table, plus valid composites), date/money/close-kind parsing (blank, `none`, `null`, `"0"`, `"undefined"`, 2099, 2076, DOD 2044), text normalization (HTML lists, links, entities, `&nbsp;` runs; plain text with literal newlines and bare entities kept line-for-line), agency code encoding (space-free subtree `CODE\|CODE-*`, quoted space code with explicit quoted descendants, `DOT-FTA - TPM` appended under `DOT-FTA`, no `CODE*`), agency parent derivation, `oppNum` quoting, ALN/eligibility normalizers | Plain Vitest unit tests; no I/O. |
| Service at the HTTP boundary | Body allowlist (the exact JSON sent per input), accept-list and classification (200 found / 200 not-found skeleton / 404 on `fetchOpportunity` / 200 backend-unavailable message / 403 / 502 / HTML body / 429 with `Retry-After`), history stripping, snapshot caching + stale-on-failure, closing-window paging and stop conditions, number resolution (unique / ambiguous / not found / uppercase retry / non-equal upstream hit filtered out / number containing a space), opportunity-number search paging (local slice, filtered `totalCount`), block-scoped field reads (posted record with a stale `forecast` block) | `createFetchMock` with trimmed fixtures recorded from the probes above: sparse cases included (forecast-only record, NSF `"none"` ceilings, DOS `"undefined"` explanation, empty `closeDate`). Contact fields in fixtures are replaced with synthetic values (`Grants Contact`, `grants-contact@agency.example`, `555-0100`). |
| Tool handlers | Input normalization in the schemas (blank → unset, case, padding, digit-string ids), `filter_conflict`/`unknown_*`/`invalid_keyword`/`no_identifiers` contracts, unconditional enrichment on every path (page, last page, zero hits, offset past end, closing-window empty), zero-hit notice composition, partial-success shape | Handler tests with `createMockContext({ errors: tool.errors })` over the fetch-mocked service; `getEnrichment(ctx)` for enrichment assertions; `expect.schemaMatching(tool.output)`. |
| `format()` | Parity (lint), CR/LF flattening in inline slots, blockquote rendering of multi-line fields, `Not available` for absent money/eligibility | Snapshot-free assertions on rendered text from sparse and full fixtures. |
| Live API | Real shapes and traps | **Not** in `bun run test`. Covered by the `field-test` skill against a running server, and by re-running this doc's probe table when the upstream changes. |

---

## Decisions Log

| Decision | Why |
|:---------|:----|
| Build on the legacy keyless `api.grants.gov` API, not Simpler.Grants.gov. | Simpler needs a per-user Login.gov-minted `X-API-Key` on every opportunity endpoint (keyless → 401), so a hosted server would run on one personal key. The legacy API is keyless and reads the same database. |
| All upstream access behind one `GrantsGovService` interface. | Legacy retirement is plausible though undated. A move to Simpler (server-held key) or to the keyless daily XML extract should be a service change, not a tool-surface change. |
| Three tools: search, get, list_reference. | Search and read cover every user goal. The reference tool is the routing target for every recovery hint, since agency codes are opaque and a bare parent code silently returns zero. |
| Keyword terms are ANDed by the tool, with operators normalized and malformed syntax rejected. | Upstream implicit OR, lowercase-operator-as-term, and dangling-operator behavior each silently widen results by 10–200×. Agents writing "rural broadband" expect both words. |
| Tokens with an internal `-` or `.` are auto-quoted. | Upstream splits and ORs them (`COVID-19` 300 vs quoted 24). The quoted form is exactly what the caller typed. |
| Agency codes expand to `CODE\|CODE-*` whenever the code has descendants, at any level. | A bare parent code matches only records filed at exactly that code (`HHS` → 0). The `-*` form is an exact subtree; `CODE*` would also catch the 27 codes that extend another code without a hyphen (`USDA-FS*` 190 vs subtree 145). |
| Agency codes with a space are sent quoted, with their descendants listed explicitly; `oppNum` is always sent quoted. | Both upstream fields are query-parsed: an unquoted space splits the value into terms and silently returns 0 or another code's rows (`DOT-FTA - TPM` → `DOT-FTA`'s 197), and `*`/`?` in a number act as wildcards. A wildcard cannot sit inside quotes, so a quoted code's subtree is enumerated from the snapshot. |
| Unknown agency, eligibility, and category codes are rejected against a live snapshot, not passed through. | Every unknown value returns 0 upstream. A typed error routed to the reference tool beats a silent empty result. |
| `include_unrestricted` defaults true. | Code `99` (open to any applicant type) is disjoint from the specific codes. Filtering on `12` alone hides every unrestricted opportunity a nonprofit can apply to. The toggle exists for "targeted at tribes specifically" searches. |
| `posted_within_days` rejects `closed`/`archived` statuses. | Upstream replaces the status filter when `dateRange` is set, returning forecasted/posted rows under an archived request. |
| `closing_within_days` forces `posted` + close-date sort and conflicts on explicit contrary values. | The window scan depends on monotonic close-date order over posted records. Silently overriding an explicit input would hide the change from the caller. |
| Sort default: relevance with a keyword, else newest-posted first. | Without a keyword, upstream default order is arbitrary. `relevance` is sent by omitting `sortBy`, since every literal relevance value returns 0. |
| Close dates carry a `close_date_kind` (`fixed`/`none_listed`/`placeholder`), and the listed date is kept. | Agencies use `01/01/2099` and posting+50-years (NSF "accepted anytime") as stand-ins. Reporting them as deadlines misleads, and dropping them would discard upstream data. The ≥ 25-years rule keeps real long-running BAAs (2034–2044) as fixed. |
| `today` is computed in US Eastern Time. | Grants.gov publishes dates in ET, and status flips to closed on the ET day after the close date (probe: rows closing 09/23 were `closed` at 01:25 ET 09/24). |
| Get takes two lists (`opportunity_ids`, `opportunity_numbers`), not one mixed list. | Digit-only opportunity numbers exist (`"1"`), so a mixed list is ambiguous between an id and a number. |
| Number resolution searches all four statuses and has an `ambiguous` outcome. | Numbers are agency-assigned and not unique (`"1"` → 5 records). The default status scope would hide closed/archived matches. |
| Misses are results (`unresolved[]`), and upstream failures throw the whole get call. | A miss is an expected fact about the input. A transient outage is not a fact about any record. |
| Money comes from the block matching `docType`, labeled `money_source`. | Posted records keep a stale forecast block with different figures (HRSA-27-005: $10.1M vs $19.2M ceiling). |
| Revision history is dropped and reported as `past_revision_count`. | `fetchOpportunity` has no field selection, and history is up to 97% of the payload (NSF 21-595: 713 of 733 KB). |
| A plain `fetch` with a per-method accept-list (`search2` {200}; `fetchOpportunity` {200, 404}), with 403 classified as `upstream_route_unavailable`. | A miss is a result, so it must never pass through a helper that throws on non-2xx. Today it arrives in-band on a 200, and a 404 is accepted in case that changes. A 403 "Missing Authentication Token" is what a retired or moved gateway route returns, and it should read as that, not as a generic outage. |
| One process-wide pacer (`maxConcurrent: 4`) and no env config. | There is no published limit, so the server stays polite for a hosted deployment without inventing a rate. Keyless with fixed URLs leaves nothing to configure. |
| HTML → text in-house, no dependency. | The upstream markup is a small tag set (surveyed), and a converter plus entity table is ~50 lines. That beats adding a parser dependency. |
| No resources, no prompts, no DataCanvas. | Tools cover every record. This is discovery over categorical metadata (find, then drill in), not rows an agent would query with SQL. |
| Deferred: `grantsgov_read_attachment` (NOFO PDF → outlined text). | Required forms and detailed eligibility often live only in the PDF, but PDF parsing and large-document handling are a separate build. v1 returns `download_url`s. |
