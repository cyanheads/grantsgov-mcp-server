<div align="center">
  <h1>@cyanheads/grantsgov-mcp-server</h1>
  <p><b>Search Grants.gov federal funding opportunities, read full records (eligibility, awards, deadlines, attachments), and decode filter codes via MCP. STDIO or Streamable HTTP.</b>
  <div>3 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/grantsgov-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/grantsgov-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/grantsgov-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/grantsgov-mcp-server/releases/latest/download/grantsgov-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=grantsgov-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZ3JhbnRzZ292LW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22grantsgov-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fgrantsgov-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

US federal funding opportunities from Grants.gov, covering every agency's forecasted, posted, closed, and archived notices. Search by keyword, agency, applicant type, funding category, assistance listing, or deadline window, then read a full record: award range, eligibility, key dates, agency contact, and NOFO attachments. The Grants.gov API is keyless, so there is nothing to configure; the server runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `grantsgov_search_opportunities` | Search opportunities by keyword and filters; each row leads with its close date and days left, plus facet counts for narrowing |
| `grantsgov_get_opportunity` | Read full records for up to 5 opportunities by numeric id or opportunity number |
| `grantsgov_list_reference` | List the codes the search filters take (agencies, applicant types, funding categories and instruments), plus statuses, sort options, and keyword syntax |

## Capability reference

### `grantsgov_search_opportunities` <sub>tool</sub>

- Filters: `keyword`, `statuses` (default `forecasted` and `posted`), `agencies` (a code includes its sub-agencies), `eligibilities`, `funding_categories`, `funding_instruments`, `assistance_listing` (one ALN), `opportunity_number` (exact match), `posted_within_days`, `closing_within_days`
- `eligibilities` also matches opportunities open to any applicant type (code `99`) unless `include_unrestricted` is `false`
- Keyword terms are all required; join alternatives with `OR`, quote phrases, exclude with `NOT` or `-term`, and use a trailing `*` for prefixes. An ungrouped AND/OR mix or a field prefix (`agency:NSF`) fails as `invalid_keyword`
- `closing_within_days` (0–365) scans posted opportunities by close date; it allows only the `posted` status and the `close_date_asc` sort, and `posted_within_days` rejects `closed` and `archived` (`filter_conflict`)
- Up to 100 rows per page (default 25) with offset paging via `next_offset`; `effective_keyword` and `applied_filters` echo what was sent, and `include_facets: false` drops the facet counts
- Rows carry `close_date_kind` (`fixed`, `none_listed`, `placeholder`) and `days_until_close`, but no award amounts. Unknown codes fail as `unknown_agency`, `unknown_eligibility`, or `unknown_funding_category`

---

### `grantsgov_get_opportunity` <sub>tool</sub>

- Up to 5 opportunities per call across `opportunity_ids` and `opportunity_numbers`; numbers resolve across all four statuses
- A miss or a number shared by several opportunities comes back in `unresolved[]` as `not_found` or `ambiguous` (with `candidates`), not as an error
- Records carry the close date (an estimate on forecasts, flagged by `close_date_is_estimate`), award ceiling and floor, total funding, expected awards, cost sharing, applicant types with the eligibility narrative, assistance listings, and the agency contact
- Funding and eligibility fields come from the synopsis or forecast block matching `doc_type`, named in `money_source`; forecasts add `forecast_estimates`
- Caps: description 12,000 characters and eligibility narrative 6,000 (cut text is flagged `*_truncated`); attachments 30 (each with a `download_url`), application packages 10, and related opportunities 10, each list with its total count

---

### `grantsgov_list_reference` <sub>tool</sub>

- `topic`: `agencies`, `eligibilities`, `funding_categories`, `funding_instruments`, `statuses`, `sort_options`, or `keyword_syntax`
- Codes come from a live Grants.gov snapshot, cached for 24 hours and dated by `snapshot_date`, with `open_count` (forecasted and posted) and `total_count` per code (`statuses` carries `total_count` only); `sort_options` and `keyword_syntax` are static
- `agencies` lists the top level by default; `parent_code` lists every code under one agency, and `name_contains` matches labels and codes on any topic (for agencies, at every level)
- `parent_code` with another topic fails as `filter_not_applicable`; an unknown code fails as `unknown_parent_code`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Grants.gov-specific:

- Keyless client for the Grants.gov REST API (`search2`, `fetchOpportunity`), with retries and at most 4 concurrent upstream requests per process
- Inputs mapped to the form Grants.gov reads as intended: bare keyword terms joined with `AND`, hyphenated tokens (`COVID-19`, `K-12`) matched as phrases, agency codes expanded to their sub-agency subtree, opportunity numbers matched literally, and filter codes checked against the live vocabulary
- Deadlines counted from today in US Eastern Time, the zone Grants.gov publishes in; far-future stand-in close dates are flagged `placeholder` rather than reported as deadlines
- Agency HTML converted to plain text; in `content[]`, multi-line agency text renders as blockquotes and inline text is flattened to one line

Agent-friendly output:

- Echo of what ran: `effective_keyword` and `applied_filters`, including defaulted statuses, the expanded agency filter, and the added code `99`
- Discriminated fields: `close_date_kind`, `doc_type`, `money_source`, and `unresolved[].outcome` let callers branch on data
- Empty-result and paging notices that name the next call, such as counts of closed and archived matches when the default statuses found nothing, or the next close date when a closing window is empty
- Typed failure reasons with recovery hints, including `upstream_unavailable`, `rate_limited`, and `upstream_route_unavailable` for Grants.gov outages

## Getting started

Add the following to your MCP client configuration file. No API key is needed.

```json
{
  "mcpServers": {
    "grantsgov-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/grantsgov-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "grantsgov-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/grantsgov-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "grantsgov-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/grantsgov-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Network access to `api.grants.gov`. No account or API key is required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/grantsgov-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd grantsgov-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# every variable is optional; the server has no settings of its own
```

## Configuration

The server reads no configuration of its own: the Grants.gov API is keyless and its endpoints are fixed. These framework variables control transport, auth, and logging.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. `.env.example` and the Docker image set `stateless`. | `auto` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker build -t grantsgov-mcp-server .
docker run --rm -p 3010:3010 grantsgov-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/grantsgov-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools and starts and disposes the Grants.gov service. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/tools` | Shared input schemas (`input-schemas.ts`) and `format()` rendering helpers (`render.ts`). |
| `src/services/grants-gov` | Grants.gov API client, keyword compiler, reference snapshot, date and money normalization, HTML-to-text. |
| `tests/` | Unit and tool tests mirroring `src/`, with trimmed Grants.gov response fixtures. |
| `docs/design.md` | Design notes: probed API behavior and the decisions behind the tool surface. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging and `ctx.fail` with the tool's declared error reasons
- Register new tools in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## Data source

Opportunity data comes from [Grants.gov](https://www.grants.gov/), where federal agencies post their funding opportunities. The records are US government works. This project is not affiliated with or endorsed by Grants.gov or any federal agency.

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
