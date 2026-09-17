# Azure DevOps MCP Server

[![CI](https://github.com/NerdFlanders/azure-devops-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/NerdFlanders/azure-devops-mcp/actions/workflows/ci.yml)

A Node.js 20+ Model Context Protocol (MCP) server using stdio for Azure DevOps integration.

## Configuration

Copy `.env.example` to `.env` or supply environment variables directly in your MCP client configuration. The server does not load `.env` files automatically unless passed with Node's `--env-file` flag or Docker's `--env-file` option.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AZURE_DEVOPS_ORG_URL` | Required | Organization or Azure DevOps Server collection URL |
| `AZURE_DEVOPS_PAT` | Required | Personal Access Token (PAT) held in the server environment |
| `AZURE_DEVOPS_PROJECT` | None | Default project context for tools that allow an omitted project |
| `AZURE_DEVOPS_TIMEOUT_MS` | `15000` | Per-request-attempt timeout in milliseconds (1–120000 ms) |
| `AZURE_DEVOPS_MAX_RETRIES` | `2` | Additional retry attempts for safe reads (0–5) |
| `AZURE_DEVOPS_METRICS` | `0` | Set `1` to emit per-tool JSON metrics to stderr |
| `AZURE_DEVOPS_READ_ONLY` | `0` | Set `1` to hide and reject create/update tools |

The example enables read-only mode for a team pilot. Existing installations
retain write access unless this variable is set. Use least-privilege PAT scopes
for the tools you enable. Reading work items requires Work Items (Read);
repository and pipeline tools require their corresponding read scopes.
Tool annotations identify reads and writes, but are not an approval mechanism.
Configure your MCP client to require human approval for writes. Treat work-item
descriptions and comments as untrusted data, not instructions to execute.

Never share a single broad PAT among untrusted users. Tool-level credential
overrides remain supported for compatibility; prefer environment configuration.
The updated endpoints target REST API 7.1 (comments use 7.1-preview.4); verify
compatibility with your on-premises Azure DevOps Server version.

## Running Locally with Node.js

### Prerequisites

- Node.js 20 or higher
- npm

### 1. Install Dependencies and Build

```bash
npm ci
npm run build
```

### 2. Run Directly

- **Production build (with `.env` file):**
  ```bash
  node --env-file=.env dist/server.js
  ```

- **Local development (hot-reloading with tsx):**
  ```bash
  npm run dev
  ```

- **Run tests:**
  ```bash
  npm test
  ```

### 3. MCP Client Configuration (Node.js)

Add the server to your MCP client configuration (e.g., Claude Desktop or VS Code MCP config):

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "node",
      "args": ["/absolute/path/to/dist/server.js"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/your-org",
        "AZURE_DEVOPS_PAT": "your-personal-access-token",
        "AZURE_DEVOPS_PROJECT": "your-project-name",
        "AZURE_DEVOPS_READ_ONLY": "0"
      }
    }
  }
}
```

---

## Running with Docker

The server can run in a containerized environment using the provided multi-stage `Dockerfile`.

### 1. Build the Docker Image

```bash
docker build -t azure-devops-mcp .
```

### 2. Run the Container

Because MCP uses `stdio` communication, run the container interactively with `-i` and remove it on exit with `--rm`:

- **Using a `.env` file:**
  ```bash
  docker run -i --rm --env-file .env azure-devops-mcp
  ```

- **Passing environment variables inline:**
  ```bash
  docker run -i --rm \
    -e AZURE_DEVOPS_ORG_URL="https://dev.azure.com/your-org" \
    -e AZURE_DEVOPS_PAT="your-personal-access-token" \
    -e AZURE_DEVOPS_PROJECT="your-project-name" \
    azure-devops-mcp
  ```

### 3. MCP Client Configuration (Docker)

Add the Dockerized server to your MCP client configuration:

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--env-file",
        "/absolute/path/to/.env",
        "azure-devops-mcp"
      ]
    }
  }
}
```

---

## Setting up in VS Code

You can integrate this MCP server with VS Code (via GitHub Copilot Chat MCP support) by adding a configuration file in your workspace.

Create or update `.vscode/mcp.json` in your project root:

### Option A: Local Node.js

```json
{
  "servers": {
    "azure-devops": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/server.js"],
      "env": {
        "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/your-org",
        "AZURE_DEVOPS_PAT": "your-personal-access-token",
        "AZURE_DEVOPS_PROJECT": "your-project-name"
      }
    }
  }
}
```

### Option B: Docker / Container (Docker or Podman)

- **Using Docker with an env file:**
  ```json
  {
    "servers": {
      "azure-devops": {
        "type": "stdio",
        "command": "docker",
        "args": [
          "run",
          "-i",
          "--rm",
          "--env-file",
          "${workspaceFolder}/.env",
          "azure-devops-mcp:latest"
        ]
      }
    }
  }
  ```

- **Using Podman with secret injection:**
  ```json
  {
    "servers": {
      "azure-devops": {
        "type": "stdio",
        "command": "podman",
        "args": [
          "run",
          "-i",
          "--rm",
          "-e", "AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-org",
          "-e", "AZURE_DEVOPS_PROJECT=your-project-name",
          "--secret", "azure-devops-pat,type=env,target=AZURE_DEVOPS_PAT",
          "azure-devops-mcp:latest"
        ]
      }
    }
  }
  ```

---

## Efficient Queries

`query_work_items`, `get_sprint_work_items`, the assignee/state/tag queries, and
`query_test_cases` accept:

- `includeDetails`: defaults to false; ID-only results use WIQL without a detail request.
- `fields`: an optional non-empty array of field reference names, used for details.
- `maxResults`: defaults to 1000, maximum 5000.

Results retain `count`, `items`, and (in ID-only mode) `ids`, and add `limit` and
`hasMore`. `count` is the number returned, not the total matching population.
When `hasMore` is true, narrow the query or raise the limit. WIQL has no generic
continuation token here; only flat work-item queries are supported. For large
exports, partition queries with explicit non-overlapping filters and ordering.

Details are fetched in batches of at most 200, with at most three batches in
flight per query. The WIQL snapshot timestamp and item ordering are preserved.
Statistics and velocity refuse to report partial aggregates.

Example arguments for `get_sprint_work_items`:

```json
{
  "project": "Example",
  "team": "Delivery Team",
  "sprint": "Example\\Sprint 12",
  "includeDetails": true,
  "fields": ["System.Title", "System.State", "System.AssignedTo"],
  "maxResults": 200
}
```

Generated queries accept `team` and honor its configured area paths and child
area settings. Statistics also accept an optional `sprint`. Raw WIQL is passed
through unchanged; include project, area, iteration and type filters yourself.

## Paging and Metrics

`list_projects`, `list_pipeline_definitions`, `get_work_item_comments`, and `get_pipeline_runs` return
`{ items, count, limit, hasMore, continuationToken }`. Supply the returned
token with the same filters for the next page. `list_teams`, `get_team_members`, and `get_work_item_history` return
`nextSkip` instead; pass it as `skip`. These tools accept `pageSize` (default
100, maximum 200). Comments require `project` or `AZURE_DEVOPS_PROJECT`.
Other collection tools retain their existing response contracts.

`get_team_velocity` now requires `project`, `team`, and the full `sprint` path.
It discovers the effort field, requirement types, bug behavior and completed
state mappings from the team's backlog configuration. Overrides are available
through `effortField`, `workItemTypes`, and `completedStates`.

The response includes `totalCompletedEffort`, the mappings used, and
`missingEstimateCount`. `totalCompletedStoryPoints` is included only when the
effort field really is Story Points. Missing estimates do not contribute to the
total; invalid estimates cause an error. This is a current-state summary, not
a historical sprint-end velocity measurement. Use revisions or Analytics for
historical cycle time, scope changes, blocked duration, and sprint-end snapshots.

## Reliability and Observability

- GETs and explicitly marked read-only WIQL/batch POSTs retry transient failures.
  Creates and updates are never automatically retried. Retries use exponential
  backoff and jitter, honoring `Retry-After`; waits above 30 seconds fail instead
  of retrying earlier than requested. Redirects are rejected.
- Each attempt has a timeout; API responses above 10 MiB are rejected. Select
  fewer fields or items when a response is too large. Responses use compact JSON.
- Projects, iterations, board metadata, team areas and backlog configuration
  are cached for 60 seconds. Keys include the full URL and a hash incorporating
  authorization headers. No work-item details or write results are cached.
  The cache holds at most 100 entries of at most 256 KiB each; restart to clear it.
  Authorization changes can take up to the TTL to affect already cached metadata.
- Opt-in stderr telemetry records tool name, success, duration, request count,
  upstream response bytes, retries, throttles and cache hits. It does not log
  PATs, URLs, tool arguments or work-item contents; stdout remains MCP-only.

Measure median/p95 tool duration, request count, payload size and throttling
before and after rollout using the stderr events. The automated tests verify
request reductions and concurrency limits, not production latency improvements.

## Migration

Restart the MCP server and refresh tool discovery after rebuilding. Update any
scripts expecting bare arrays from the four paged tools to read `items` and
follow their continuation fields. Update velocity callers to provide team and
sprint and consume `totalCompletedEffort`. Check `hasMore` on query results
instead of assuming the response covers the entire project.