# Agent Protocol

**Server:** grantsgov-mcp-server (npm `@cyanheads/grantsgov-mcp-server`)
**Version:** 0.1.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.6`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**Upstream:** Grants.gov legacy REST API (`https://api.grants.gov/v1/api`: `POST search2`, `POST fetchOpportunity`) — keyless, no env config

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

> **Design record:** `docs/design.md` holds the probed upstream behavior (every silent-widening trap, with counts), the response-size budget, and the decisions log. Read it before changing a filter, the keyword compiler, or a service method, and update it when behavior changes.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Run the `field-test` skill** — exercise the three tools against live Grants.gov with real and adversarial inputs
2. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks
3. **Run the `tool-defs-analysis` skill** — audit the definition language the LLM reads
4. **Add a tool** — the deferred `grantsgov_read_attachment` (NOFO PDF → outlined text) is in the design doc's decisions log; scaffold with the `add-tool` skill
5. **Run the `polish-docs-meta` skill** — re-sync README, metadata, and this file after a surface change
6. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Surface

| Tool | Upstream calls | Notes |
|:-----|:---------------|:------|
| `grantsgov_search_opportunities` | 1× `search2`; 1–4 pages of 500 for `closing_within_days`; 1–2 for `opportunity_number`; plus the cached reference snapshot when `agencies` / `eligibilities` / `funding_categories` is set | Three modes share one enrichment contract: plain upstream page, exact opportunity-number match paged locally, server-side closing-window scan |
| `grantsgov_get_opportunity` | `search2` per opportunity number (resolution, all statuses), then `fetchOpportunity` per id, fanned out through the pacer | Up to 5 identifiers; misses and ambiguous numbers are `unresolved[]` entries, upstream failures throw the whole call |
| `grantsgov_list_reference` | The reference snapshot (2× `search2` with `rows: 0`, cached 24 h), or none for `sort_options` / `keyword_syntax` | Every recovery hint for an unknown code routes here |

No resources, no prompts, no DataCanvas — every record is reachable through `grantsgov_get_opportunity` (see the decisions log).

### Service

`GrantsGovService` (`src/services/grants-gov/grants-gov-service.ts`) is the only upstream boundary: `search`, `fetchOpportunity`, `resolveNumber`, `scanClosingWindow`, `getReference`, `dispose`. Init in `createApp({ setup })`, dispose in `teardown` (it owns the pacer's timer).

- **Transport:** plain `fetch` with a per-endpoint status accept-list (`search2` {200}; `fetchOpportunity` {200, 404}). A non-accepted status is never parsed as data: 403 → `upstream_route_unavailable` (non-retryable — the legacy route is gone), 5xx → `upstream_unavailable`, 429 → `rate_limited`. A 200 with HTML, bad JSON, `errorcode !== 0`, or a "not available" message is `upstream_unavailable`.
- **Resilience:** `withRetry` (2 retries, 25 s deadline) outside, the process-wide pacer (`maxConcurrent: 4`) inside, so each attempt re-queues. Per-attempt timeout 15 s.
- **Reason propagation:** every service throw carries `data.reason` plus the calling tool's `ctx.recoveryFor(reason)`. Each tool declares `upstream_unavailable`, `rate_limited`, and `upstream_route_unavailable` with `thrownBy: 'service'`, each with its own tool-named recovery text.
- **Reference snapshot:** process-local (public vocabulary, not tenant data — never `ctx.state`), 24 h TTL, one in-flight build shared by concurrent callers. A failed refresh serves the stale snapshot and blocks retries for 60 s; a failure with no snapshot is re-issued to each caller with its own recovery hint.
- **`Search2Body` is a closed interface.** Grants.gov ignores unknown keys and silently widens to the default scope, so no caller input is ever spread into a body. A new filter means a new typed key, probed first.

### Upstream traps the tools close

Each returns HTTP 200 with a plausible count, so the tool boundary maps the input to the working form or rejects it with a typed error. Full probe table in `docs/design.md`.

| Input | Upstream behavior | Where it's handled |
|:------|:------------------|:-------------------|
| Multi-value filters | Pipe-joined string only; arrays and commas return 0 | Handler joins with `\|` |
| Agency codes | A bare parent matches only records filed at exactly that code; codes with spaces split into terms | `encodeAgencyFilter` (`reference.ts`): `CODE\|CODE-*` for subtrees (never `CODE*`, which catches unrelated codes), codes with spaces quoted with descendants listed explicitly |
| Lowercase codes, single-digit eligibility | Match nothing | Schema normalization (uppercase, zero-pad) |
| `oppNum` | Query-parsed (`*` wildcards, spaces split), case-sensitive, returns non-equal hits | `quoteOppNum` always quotes; `isSameOpportunityNumber` post-filters; one uppercase retry on a lowercase miss |
| `dateRange` with `closed`/`archived` | Drops the status filter | `filter_conflict` |
| No close-date filter exists | — | `scanClosingWindow` over `closeDate\|asc` posted pages, cut by `cutClosingWindow`, 2,000-row ceiling |
| Relevance sort | Every literal `sortBy` value returns 0 | Sent by omitting `sortBy` |

### Keyword grammar

`compileKeyword` (`src/services/grants-gov/keyword.ts`) is a pure function returning `{ ok: true, compiled, andJoined } | { ok: false, problem, hint? }`. Rules:

- Bare adjacent terms are joined with `AND` (upstream implicit OR widens 10–200×).
- `and` / `or` / `not` standing alone are operators in any case, uppercased; `&&` / `||` read as `AND` / `OR`; a leading `-term` is `NOT term`.
- A token with an internal `-` or `.` (`COVID-19`, `K-12`, `93.866`) is auto-quoted as a phrase; wildcard tokens stay bare so a trailing `*` keeps working.
- `: ~ ? [ ] { } ^ \ / ! +` are replaced by a space.
- Rejected as `invalid_keyword`: a field prefix (`agency:NSF` — the hint names the filter that does the job), AND and OR mixed in one grouping level without parentheses (the hint spells out both groupings), unbalanced quotes or parentheses, a leading `AND`/`OR`, a trailing or doubled operator, empty parentheses, or nothing searchable left.

**Keep three places in sync** when the grammar changes: `keyword.ts`, the `keyword` `.describe()` and tool description in `grantsgov-search-opportunities.tool.ts`, and the `keyword_syntax` entries in `grantsgov-list-reference.tool.ts`.

### Dates and deadlines

`todayET()` is the reference day everywhere: Grants.gov publishes in US Eastern Time and flips status to closed on the ET day after the close date. `closeDateKind` returns `placeholder` for close dates ≥ 25 years out (`01/01/2099`, NSF posting + 50 years), and the listed date is always kept. Search rows for forecasts carry no close date (`none_listed`); the estimate lives on the `grantsgov_get_opportunity` record.

### Untrusted text

Agency-authored text (titles, descriptions, eligibility narratives, contact blocks, file names, labels) is data. `html-to-text.ts` normalizes HTML and bare-entity text for both surfaces; `structuredContent` otherwise stays verbatim. In `format()`, use the `render.ts` helpers: `inline()` for text inside a line, `tableCell()` inside a table cell, `blockquote()` for multi-line fields. Never interpolate raw upstream text into `content[]`.

---

## Patterns

### Input schemas

`src/mcp-server/tools/input-schemas.ts` holds the conventions every tool uses:

- **Blank means unset.** `optionalText(schema)` and `optionalList(item, max)` read `''`, whitespace, and emptied lists as `undefined`. Never `.min(1)` on an optional string.
- **Advertise the raw form, validate the normalized one.** `normalizedString(raw, message, normalize, normalized)` builds `z.string().regex(raw).transform(normalize).pipe(normalized)`. `tools/list` emits only the first stage, so `raw` (built with `rawPattern()`, no regex flags) must admit every spelling the `.describe()` promises — any case, surrounding whitespace, blank. A `z.preprocess` in front of a pattern would advertise the post-normalization pattern, and a client validating against `tools/list` would reject `hhs`, `7`, or `"363423"` before the server sees them.
- Enum inputs keep their canonical `z.enum` behind a `trimLower` / `trimUpper` preprocess; digit-string numbers go through `numberFromDigits`.

### Tool

Abridged from `grantsgov-list-reference.tool.ts`:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGrantsGovService } from '@/services/grants-gov/grants-gov-service.js';
import { resolveAgencyScope } from '@/services/grants-gov/reference.js';
import { AGENCY_CODE_INPUT, optionalText, trimLower } from '../input-schemas.js';
import { tableCell } from '../render.js';

export const grantsgovListReference = tool('grantsgov_list_reference', {
  title: 'List Grants.gov Reference Codes',
  description: 'List the codes Grants.gov search filters accept, with labels and live opportunity counts: …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    topic: z.preprocess(trimLower, z.enum(TOPICS)).describe('Which list to return: …'),
    name_contains: optionalText(z.string().max(100)).describe('Keep only entries whose label or code contains every word given, …'),
    parent_code: optionalText(AGENCY_CODE_INPUT).describe('Agencies only: list every code under this agency at any depth …'),
  }),
  output: z.object({ /* topic, entries[], snapshot_date */ }),
  enrichment: {
    totalCount: z.number().describe('Entries returned.'),
    notice: z.string().optional().describe('Guidance when name_contains matched nothing, …'),
  },

  errors: [
    { reason: 'unknown_parent_code', code: JsonRpcErrorCode.NotFound,
      when: 'parent_code is not a known agency code.',
      recovery: 'Call grantsgov_list_reference with topic agencies and name_contains set to the agency name to find its code.' },
    { reason: 'upstream_unavailable', code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The snapshot fetch failed after retries and no cached snapshot exists.',
      recovery: 'Grants.gov is not responding; wait a minute and call grantsgov_list_reference again.',
      retryable: true, thrownBy: 'service' },
    // … filter_not_applicable, rate_limited, upstream_route_unavailable
  ],

  async handler(input, ctx) {
    ctx.enrich.total(0);
    const { topic, parent_code: parentCode } = input;
    const snapshot = await getGrantsGovService().getReference(ctx);
    if (topic === 'agencies' && parentCode !== undefined) {
      const scope = resolveAgencyScope(snapshot, parentCode);
      if (!scope) {
        throw ctx.fail('unknown_parent_code', `No agency code "${parentCode}" in the Grants.gov vocabulary.`, {
          parentCode,
          ...ctx.recoveryFor('unknown_parent_code'),
        });
      }
    }
    // … build entries, filter by name_contains, set notices
    ctx.enrich.total(entries.length);
    return { topic, entries, snapshot_date: snapshot.fetchedAt };
  },

  format: (result) => [{ type: 'text', text: /* table built with tableCell() */ '' }],
});
```

### Server identity and instructions

`src/index.ts` sets `name` and `title` to the unscoped repo name (`lint:packaging` enforces the match), registers `allToolDefinitions`, and carries the server `instructions` string from the design doc. `description` is never set there — `package.json` is the canonical source.

### Server config

None. The API is keyless and the base URL is a constant in the service, so there is no `src/config/server-config.ts`. Adding an env var means creating it (`parseEnvConfig` + Zod, see the framework docs) and declaring the variable in `server.json`, `manifest.json` (`mcp_config.env` + `user_config`), `.claude-plugin/plugin.json` (`userConfig` + `env`), `.codex-plugin/mcp.json` (`env_vars`), `.env.example`, and the README Configuration table.

---

## Context

Handlers receive a unified `ctx` object. This server uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.enrich` | Success-path agent context — `ctx.enrich({...})` or `.notice()` / `.total()` / `.truncated()`. Lands only for fields the definition declares in `enrichment`. Search uses it for `totalCount`, `next_offset`, `effective_keyword`, `applied_filters`, and zero-hit notices. |
| `ctx.fail(reason, …)` | Throws a typed contract error for a declared reason. |
| `ctx.recoveryFor(reason)` | Returns `{ recovery: { hint } }` for a declared reason — spread into `ctx.fail` data, and passed by the service into its own throws. |
| `ctx.signal` | `AbortSignal` for cancellation — threaded into `withRetry`; the closing-window scan checks it between pages. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Typed error contract on every tool.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` and throw with `ctx.fail(reason, message, data)`. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. Forward it with `ctx.recoveryFor('reason')`, or pass an explicit `{ recovery: { hint } }` when runtime context sharpens it (the search tool names the unknown agency code in its hint). Forwarding is lint-enforced per throw site (`error-contract-recovery-unforwarded`). Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Misses are results, outages are errors.** An unresolved id or number is an `unresolved[]` entry with guidance; a zero-hit search is an empty page with a notice. Only invalid input and upstream failure throw.

**Service-layer throws** use factories (`serviceUnavailable`, `httpErrorFromResponse`) with `data: { reason, ...ctx.recoveryFor(reason) }`, so clients see the same `error.data.reason` they'd see from `ctx.fail`.

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                                    # createApp(): tools, instructions, service setup/teardown
  mcp-server/tools/
    input-schemas.ts                          # Blank-as-unset, raw-form pattern inputs, shared code inputs
    render.ts                                 # inline / tableCell / blockquote for agency text in format()
    definitions/
      index.ts                                # allToolDefinitions barrel
      grantsgov-search-opportunities.tool.ts
      grantsgov-get-opportunity.tool.ts
      grantsgov-list-reference.tool.ts
  services/grants-gov/
    grants-gov-service.ts                     # Upstream client: fetch, retry, pacer, reference cache
    keyword.ts                                # compileKeyword
    reference.ts                              # Snapshot build, agency tree, agency filter encoding
    normalize.ts                              # ET dates, close-date kind, money/count parsing, entities
    html-to-text.ts                           # Agency HTML → plain text
    types.ts                                  # Raw upstream shapes (all optional) and service results
tests/                                        # Mirrors src/; fixtures/ holds trimmed live responses and the failure harness
docs/design.md                                # Probed API behavior, budgets, decisions log
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `grantsgov-get-opportunity.tool.ts` |
| Tool names | snake_case, `grantsgov_` prefix | `grantsgov_get_opportunity` |
| Input/output fields | snake_case | `opportunity_numbers`, `close_date_kind` |
| Directories | kebab-case | `src/services/grants-gov/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Read the full Grants.gov record for up to 5 opportunities, …'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + packaging alignment + changelog sync |
| `bun run tree` | Regenerate `docs/tree.md` |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with coverage |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run list-skills` | Print the skill registry |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity, plugin manifest identity, README version badge (run by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run release:github` | Create the GitHub Release from an annotated tag and attach the `.mcpb` bundle |
| `bun run publish-mcp` | Log in to the MCP Registry and publish `server.json` |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

**CI is one file.** `.github/workflows/codeql.yml` is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces `dist/grantsgov-mcp-server.mcpb` for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP and Docker deployments are unaffected. The `release-and-publish` skill attaches the bundle to the GitHub Release at a stable `releases/latest/download/grantsgov-mcp-server.mcpb` URL that powers the README install badge.

`manifest.json` declares no `user_config` (the server has no settings). `lint:packaging` (run by `devcheck`) keeps it in step with `server.json` and the plugin manifests; see *Server config* above for what an env var would touch.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getGrantsGovService } from '@/services/grants-gov/grants-gov-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional inputs use `optionalText` / `optionalList`; pattern inputs use `normalizedString` with a `rawPattern` that admits every spelling the `.describe()` promises
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging; process-wide caches stay in the service, tenant data in `ctx.state`
- [ ] Handlers throw on failure via `ctx.fail` with a declared reason — no try/catch; service-thrown reasons declared with `thrownBy: 'service'`
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data. Agency text goes through `inline` / `tableCell` / `blockquote`
- [ ] New upstream field or filter: probed against the live API first, added to the closed `Search2Body` / raw types as optional, and recorded in `docs/design.md`
- [ ] Normalization and `format()` preserve uncertainty; missing upstream values stay absent, never fabricated (a listed `0` stays `0`)
- [ ] Tests include at least one sparse payload case with omitted upstream fields
- [ ] Keyword grammar changes reflected in `keyword.ts`, the search tool's `keyword` description, and the `keyword_syntax` reference entries
- [ ] Registered in `allToolDefinitions` (`src/mcp-server/tools/definitions/index.ts`)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/mcp.json`, `manifest.json`, and `server.json` in sync with `package.json` (name unscoped on display fields, `npx -y @cyanheads/grantsgov-mcp-server` install arg, version, description); an added env var goes into every one of them
- [ ] `bun run devcheck` passes
