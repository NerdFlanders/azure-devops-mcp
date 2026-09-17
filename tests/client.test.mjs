import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { callAzureDevOps, callAzureDevOpsPage, queryProjectItems, queryWorkItems } from "../dist/client.js";
import { measureTool } from "../dist/telemetry.js";
import { handleToolCall } from "../dist/handlers.js";
import { TOOLS, getAvailableTools } from "../dist/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const originalFetch = globalThis.fetch;
const config = { organizationUrl: "https://dev.azure.com/example", personalAccessToken: "test-token" };
const response = (value) => new Response(JSON.stringify(value), { status: 200 });
const toolInput = { ...config, project: "Project" };
const toolValue = (result) => JSON.parse(result.content[0].text);
afterEach(() => { globalThis.fetch = originalFetch; });

test("ID-only queries make one request and report truncation", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response({ workItems: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  };
  const result = await queryWorkItems(config, "My Project", "SELECT [System.Id] FROM WorkItems", {
    includeDetails: false, maxResults: 2,
  });
  assert.deepEqual(result, { items: [{ id: 1 }, { id: 2 }], count: 2, hasMore: true, limit: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get("$top"), "3");
  assert.ok(calls[0].url.pathname.includes("My%20Project"));
});

test("details use batches of 200, three concurrent requests, fields and snapshot", async () => {
  const references = Array.from({ length: 801 }, (_, index) => ({ id: index + 1 }));
  let active = 0;
  let peak = 0;
  const batches = [];
  globalThis.fetch = async (url, options) => {
    if (url.pathname.endsWith("/wiql")) return response({ workItems: references, asOf: "2026-09-15T00:00:00Z" });
    const body = JSON.parse(options.body);
    batches.push(body);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return response({ value: body.ids.map((id) => ({ id })).reverse() });
  };
  const result = await queryWorkItems(config, "Project", "query", { fields: ["System.Title"] });
  assert.deepEqual(result.items, references);
  assert.deepEqual(batches.map((batch) => batch.ids.length), [200, 200, 200, 200, 1]);
  assert.equal(peak, 3);
  for (const batch of batches) {
    assert.deepEqual(batch.fields, ["System.Title"]);
    assert.equal(batch.asOf, "2026-09-15T00:00:00Z");
  }
});

test("empty queries do not fetch details", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return response({ workItems: [] }); };
  assert.equal((await queryWorkItems(config, "Project", "query")).count, 0);
  assert.equal(calls, 1);
});

test("invalid bounds and field lists fail before HTTP", async () => {
  globalThis.fetch = async () => { assert.fail("Unexpected HTTP request"); };
  for (const maxResults of [0, 5001, 1.5]) {
    await assert.rejects(queryWorkItems(config, "Project", "query", { maxResults }), /maxResults/);
  }
  await assert.rejects(queryWorkItems(config, "Project", "query", { fields: [] }), /fields/);
});

test("aggregates refuse partial results", async () => {
  globalThis.fetch = async () => response({ workItems: [{ id: 1 }, { id: 2 }] });
  await assert.rejects(queryProjectItems(config, "Project", "query", {
    maxResults: 1, includeDetails: false,
  }), /Narrow the query/);
});

test("link queries and incomplete detail responses are not reported as complete", async () => {
  globalThis.fetch = async () => response({ workItemRelations: [] });
  await assert.rejects(queryWorkItems(config, "Project", "query"), /flat WIQL/);
  globalThis.fetch = async (url) => response(url.pathname.endsWith("/wiql") ? { workItems: [{ id: 1 }] } : { value: [] });
  await assert.rejects(queryWorkItems(config, "Project", "query"), /incomplete/);
});

test("safe reads retry throttling and preserve continuation headers", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("upstream busy", { status: 429, headers: { "Retry-After": "0" } })
      : new Response('{"value":[]}', { headers: { "x-ms-continuationtoken": "next-page" } });
  };
  assert.deepEqual(await callAzureDevOpsPage(config, "/projects"), { data: { value: [] }, continuationToken: "next-page" });
  assert.equal(calls, 2);
});

test("writes, authorization failures and long Retry-After values are not retried", async () => {
  for (const [method, status, retryAfter] of [["POST", 503, "0"], ["PATCH", 429, "0"], ["GET", 401, "0"], ["GET", 429, "60"]]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("not JSON", { status, headers: { "Retry-After": retryAfter } });
    };
    await assert.rejects(callAzureDevOps(config, "/items", { method }), new RegExp(String(status)));
    assert.equal(calls, 1);
  }
});

test("WIQL POST requests are explicitly safe to retry", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response("", { status: 503, headers: { "Retry-After": "0" } }) : response({ workItems: [] });
  };
  await queryWorkItems(config, "Project", "query", { includeDetails: false });
  assert.equal(calls, 2);
});

test("timeouts abort requests", async () => {
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  await assert.rejects(callAzureDevOps(config, "/items", { timeoutMs: 5, maxRetries: 0 }), /timed out/);
});

test("metadata cache is isolated by credentials and organization and returns copies", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return response({ value: [calls] }); };
  const options = { cacheTtlMs: 60000 };
  const first = await callAzureDevOps(config, "/cached-metadata", options);
  first.value.push(99);
  assert.deepEqual(await callAzureDevOps(config, "/cached-metadata", options), { value: [1] });
  await callAzureDevOps({ ...config, personalAccessToken: "other-token" }, "/cached-metadata", options);
  await callAzureDevOps({ ...config, organizationUrl: "https://dev.azure.com/other" }, "/cached-metadata", options);
  assert.equal(calls, 3);
});

test("oversized responses are rejected", async () => {
  globalThis.fetch = async () => response("x".repeat(10 * 1024 * 1024));
  await assert.rejects(callAzureDevOps(config, "/large"), /exceeds 10 MiB/);
});

test("telemetry records counts without credentials, URLs or arguments", async () => {
  const originalError = console.error;
  const previous = process.env.AZURE_DEVOPS_METRICS;
  const logs = [];
  process.env.AZURE_DEVOPS_METRICS = "1";
  console.error = (line) => logs.push(JSON.parse(line));
  globalThis.fetch = async () => response({ value: [] });
  try {
    await measureTool("list_projects", () => callAzureDevOps(config, "/metrics"));
    assert.equal(logs[0].requests, 1);
    assert.equal(logs[0].success, true);
    assert.ok(logs[0].responseBytes > 0);
    assert.ok(!JSON.stringify(logs).includes(config.personalAccessToken));
    assert.ok(!JSON.stringify(logs).includes(config.organizationUrl));
  } finally {
    console.error = originalError;
    if (previous === undefined) delete process.env.AZURE_DEVOPS_METRICS;
    else process.env.AZURE_DEVOPS_METRICS = previous;
  }
});

test("all query tools honor ID-only results and advertised limits", async () => {
  const inputs = {
    query_work_items: { query: "SELECT [System.Id] FROM WorkItems" },
    get_sprint_work_items: { sprint: "Project\\Sprint 1" },
    query_work_items_by_assignee: { assignee: "person@example.com" },
    query_work_items_by_state: { state: "Active" },
    query_work_items_by_tag: { tag: "Blocked" },
    query_test_cases: {},
  };
  for (const [name, input] of Object.entries(inputs)) {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      assert.ok(url.pathname.endsWith("/wiql"));
      assert.equal(url.searchParams.get("$top"), "2");
      return response({ workItems: [{ id: 1 }, { id: 2 }] });
    };
    const result = toolValue(await handleToolCall(name, { ...toolInput, ...input, maxResults: 1 }));
    assert.deepEqual(result.ids, [1]);
    assert.equal(result.hasMore, true);
    assert.equal(calls, 1);
    const schema = TOOLS.find((tool) => tool.name === name).inputSchema;
    assert.ok(schema.properties.maxResults);
    assert.ok(schema.properties.fields);
  }
});

test("query tool passes selected fields into the batch request", async () => {
  globalThis.fetch = async (url, options) => {
    if (url.pathname.endsWith("/wiql")) return response({ workItems: [{ id: 1 }] });
    assert.deepEqual(JSON.parse(options.body).fields, ["System.Title"]);
    return response({ value: [{ id: 1, fields: { "System.Title": "Example" } }] });
  };
  const result = toolValue(await handleToolCall("query_work_items", {
    ...toolInput, query: "query", includeDetails: true, fields: ["System.Title"],
  }));
  assert.equal(result.items[0].fields["System.Title"], "Example");
});

test("team sprint queries use configured area paths and escape literals", async () => {
  globalThis.fetch = async (url, options) => {
    if (url.pathname.endsWith("/teamfieldvalues")) {
      assert.ok(url.pathname.includes("/Project/Team%20Scope/"));
      return response({ field: { referenceName: "System.AreaPath" }, values: [
        { value: "Project\\Team's Area", includeChildren: true },
        { value: "Project\\Exact", includeChildren: false },
      ] });
    }
    const query = JSON.parse(options.body).query;
    assert.ok(query.includes("[System.AreaPath] UNDER 'Project\\Team''s Area'"));
    assert.ok(query.includes("[System.AreaPath] = 'Project\\Exact'"));
    assert.ok(query.includes("[System.IterationPath] = 'Project\\Sprint 1'"));
    return response({ workItems: [] });
  };
  await handleToolCall("get_sprint_work_items", { ...toolInput, team: "Team Scope", sprint: "Project\\Sprint 1" });
});

test("velocity discovers Scrum, Agile and custom effort and state mappings", async () => {
  for (const [team, effortField, type, state] of [
    ["Scrum", "Microsoft.VSTS.Scheduling.Effort", "Product Backlog Item", "Done"],
    ["Agile", "Microsoft.VSTS.Scheduling.StoryPoints", "User Story", "Closed"],
    ["Custom", "Custom.Size", "Requirement", "Accepted"],
  ]) {
    globalThis.fetch = async (url, options) => {
      if (url.pathname.endsWith("/teamfieldvalues")) return response({ field: { referenceName: "System.AreaPath" }, values: [{ value: `Project\\${team}`, includeChildren: true }] });
      if (url.pathname.endsWith("/backlogconfiguration")) return response({
        backlogFields: { typeFields: { Effort: effortField } },
        requirementBacklog: { workItemTypes: [{ name: type }, { name: "Bug" }] },
        bugsBehavior: "asTasks",
        workItemTypeMappedStates: [{ workItemTypeName: type, states: { [state]: "Completed", Active: "InProgress" } }],
      });
      if (url.pathname.endsWith("/wiql")) {
        const query = JSON.parse(options.body).query;
        assert.ok(query.includes(`[System.State] IN ('${state}')`));
        assert.ok(query.includes(`[System.WorkItemType] = '${type}'`));
        assert.ok(query.includes(`[System.AreaPath] UNDER 'Project\\${team}'`));
        assert.ok(!query.includes("'Bug'"));
        return response({ workItems: [{ id: 1 }, { id: 2 }] });
      }
      assert.deepEqual(JSON.parse(options.body).fields, [effortField]);
      return response({ value: [{ id: 1, fields: { [effortField]: 8 } }, { id: 2, fields: {} }] });
    };
    const result = toolValue(await handleToolCall("get_team_velocity", { ...toolInput, team, sprint: "Project\\Sprint 1" }));
    assert.equal(result.totalCompletedEffort, 8);
    assert.equal(result.missingEstimateCount, 1);
    assert.deepEqual(result.workItemTypes, [type]);
    assert.equal(result.totalCompletedStoryPoints, team === "Agile" ? 8 : undefined);
  }
});

test("velocity requires a team and sprint and refuses missing metadata", async () => {
  await assert.rejects(handleToolCall("get_team_velocity", toolInput), /team/);
  await assert.rejects(handleToolCall("get_team_velocity", { ...toolInput, team: "No Sprint" }), /sprint/);
  globalThis.fetch = async () => response({});
  await assert.rejects(handleToolCall("get_team_velocity", { ...toolInput, team: "Missing Metadata", sprint: "Sprint" }), /area-path/);
});

test("iteration aliases use the team route and cached metadata", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.equal(url.pathname, "/example/Project/My%20Team/_apis/work/teamsettings/iterations");
    return response({ value: [{ name: "Sprint 1" }] });
  };
  const input = { ...toolInput, team: "My Team" };
  await handleToolCall("get_team_iterations", input);
  await handleToolCall("get_team_sprints", input);
  assert.equal(calls, 1);
});

test("project and build pages forward and return continuation tokens", async () => {
  for (const name of ["list_projects", "get_pipeline_runs"]) {
    globalThis.fetch = async (url) => {
      assert.equal(url.searchParams.get("continuationToken"), "previous");
      assert.equal(url.searchParams.get("$top"), "2");
      if (name === "get_pipeline_runs") assert.equal(url.searchParams.get("definitions"), "42");
      return new Response('{"value":[{"id":1}]}', { headers: { "x-ms-continuationtoken": "next" } });
    };
    const result = toolValue(await handleToolCall(name, { ...toolInput, pageSize: 2, continuationToken: "previous", definitionId: 42 }));
    assert.equal(result.hasMore, true);
    assert.equal(result.continuationToken, "next");
    assert.equal(result.count, 1);
  }
});

test("comments preserve body continuation tokens and project route", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(url.pathname, "/example/Project/_apis/wit/workItems/1/comments");
    assert.equal(url.searchParams.get("continuationToken"), "previous");
    assert.equal(url.searchParams.get("$top"), "2");
    return response({ comments: [{ id: 10 }], continuationToken: "next" });
  };
  const result = toolValue(await handleToolCall("get_work_item_comments", { ...toolInput, id: 1, pageSize: 2, continuationToken: "previous" }));
  assert.equal(result.continuationToken, "next");
  assert.equal(result.hasMore, true);
});

test("revision pages return nextSkip without dropping the extra revision", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(url.searchParams.get("$top"), "3");
    assert.equal(url.searchParams.get("$skip"), "2");
    return response({ value: [{ rev: 3 }, { rev: 4 }, { rev: 5 }] });
  };
  const result = toolValue(await handleToolCall("get_work_item_history", { ...toolInput, id: 1, pageSize: 2, skip: 2 }));
  assert.equal(result.nextSkip, 4);
  assert.deepEqual(result.items, [{ rev: 3 }, { rev: 4 }]);
});

test("read-only mode hides write tools and rejects direct calls before HTTP", async () => {
  const previous = process.env.AZURE_DEVOPS_READ_ONLY;
  process.env.AZURE_DEVOPS_READ_ONLY = "1";
  globalThis.fetch = async () => { assert.fail("Unexpected HTTP request"); };
  try {
    for (const name of ["create_work_item", "update_work_item"]) {
      assert.ok(!getAvailableTools().some((tool) => tool.name === name));
      await assert.rejects(handleToolCall(name, toolInput), /writes are disabled/);
      assert.equal(TOOLS.find((tool) => tool.name === name).annotations.readOnlyHint, false);
    }
    assert.equal(getAvailableTools().find((tool) => tool.name === "get_work_item").annotations.readOnlyHint, true);
  } finally {
    if (previous === undefined) delete process.env.AZURE_DEVOPS_READ_ONLY;
    else process.env.AZURE_DEVOPS_READ_ONLY = previous;
  }
});

test("invalid paging inputs fail before HTTP", async () => {
  globalThis.fetch = async () => { assert.fail("Unexpected HTTP request"); };
  await assert.rejects(handleToolCall("list_projects", { ...toolInput, pageSize: 201 }), /pageSize/);
  await assert.rejects(handleToolCall("get_work_item_history", { ...toolInput, id: 1, skip: -1 }), /skip/);
  await assert.rejects(handleToolCall("list_teams", { ...toolInput, skip: -1 }), /skip/);
  await assert.rejects(handleToolCall("get_team_members", { ...toolInput, team: "Team", skip: -1 }), /skip/);
});

test("team listing and membership tools support paging and filters", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(url.pathname, "/example/_apis/projects/Project/teams");
    assert.equal(url.searchParams.get("$top"), "3");
    assert.equal(url.searchParams.get("$skip"), "2");
    assert.equal(url.searchParams.get("mine"), "true");
    return response({ value: [{ id: "t1", name: "Team 1" }, { id: "t2", name: "Team 2" }, { id: "t3", name: "Team 3" }] });
  };
  const result = toolValue(await handleToolCall("list_teams", { ...toolInput, pageSize: 2, skip: 2, mine: true }));
  assert.equal(result.count, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextSkip, 4);
  assert.deepEqual(result.items, [{ id: "t1", name: "Team 1" }, { id: "t2", name: "Team 2" }]);

  globalThis.fetch = async (url) => {
    assert.equal(url.pathname, "/example/_apis/projects/Project/teams/My%20Team/members");
    assert.equal(url.searchParams.get("$top"), "3");
    return response({ value: [{ identity: { displayName: "Alice" } }] });
  };
  const membersResult = toolValue(await handleToolCall("get_team_members", { ...toolInput, team: "My Team", pageSize: 2 }));
  assert.equal(membersResult.count, 1);
  assert.equal(membersResult.hasMore, false);
  assert.equal(membersResult.nextSkip, null);
});

test("team capacity retrieves iteration capacities for a team", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(url.pathname, "/example/Project/My%20Team/_apis/work/teamsettings/iterations/iter-guid/capacities");
    return response({ teamMembers: [{ teamMember: { displayName: "Bob" }, activities: [{ capacityPerDay: 6 }] }] });
  };
  const capacityResult = toolValue(await handleToolCall("get_team_capacity", { ...toolInput, team: "My Team", iterationId: "iter-guid" }));
  assert.equal(capacityResult.teamMembers[0].teamMember.displayName, "Bob");
});

test("pipeline definition listing, runs, timeline and logs work as expected", async () => {
  // list_pipeline_definitions
  globalThis.fetch = async (url) => {
    assert.equal(url.pathname, "/example/Project/_apis/build/definitions");
    assert.equal(url.searchParams.get("name"), "CI-Build");
    assert.equal(url.searchParams.get("repositoryId"), "repo-1");
    return new Response('{"value":[{"id":10,"name":"CI-Build"}]}', { headers: { "x-ms-continuationtoken": "token-123" } });
  };
  const defsResult = toolValue(await handleToolCall("list_pipeline_definitions", { ...toolInput, name: "CI-Build", repositoryId: "repo-1" }));
  assert.equal(defsResult.count, 1);
  assert.equal(defsResult.hasMore, true);
  assert.equal(defsResult.continuationToken, "token-123");

  // get_pipeline_run
  globalThis.fetch = async (url) => {
    assert.equal(url.pathname, "/example/Project/_apis/build/builds/100");
    return response({ id: 100, buildNumber: "2026.1", status: "completed", result: "succeeded" });
  };
  const runResult = toolValue(await handleToolCall("get_pipeline_run", { ...toolInput, runId: 100 }));
  assert.equal(runResult.id, 100);
  assert.equal(runResult.result, "succeeded");

  // get_pipeline_run_timeline
  globalThis.fetch = async (url) => {
    assert.equal(url.pathname, "/example/Project/_apis/build/builds/100/timeline");
    return response({ records: [{ name: "Build Stage", type: "Stage", result: "succeeded" }] });
  };
  const timelineResult = toolValue(await handleToolCall("get_pipeline_run_timeline", { ...toolInput, runId: 100 }));
  assert.equal(timelineResult.records[0].name, "Build Stage");

  // get_pipeline_run_logs list
  globalThis.fetch = async (url) => {
    assert.equal(url.pathname, "/example/Project/_apis/build/builds/100/logs");
    return response({ value: [{ id: 1, type: "Container" }] });
  };
  const logsListResult = toolValue(await handleToolCall("get_pipeline_run_logs", { ...toolInput, runId: 100 }));
  assert.equal(logsListResult[0].id, 1);

  // get_pipeline_run_logs single
  globalThis.fetch = async (url) => {
    assert.equal(url.pathname, "/example/Project/_apis/build/builds/100/logs/1");
    return response({ count: 10, value: ["Build started", "Build completed"] });
  };
  const logContentResult = toolValue(await handleToolCall("get_pipeline_run_logs", { ...toolInput, runId: 100, logId: 1 }));
  assert.equal(logContentResult.count, 10);
});

test("read retries stop at the configured attempt budget", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
  };
  await assert.rejects(callAzureDevOps(config, "/retry-budget", { maxRetries: 2 }), /503/);
  assert.equal(calls, 3);
});

test("metadata expires and uncached reads remain fresh", async () => {
  let calls = 0;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  globalThis.fetch = async () => { calls += 1; return response({ value: calls }); };
  try {
    await callAzureDevOps(config, "/expiry", { cacheTtlMs: 1000 });
    now += 1001;
    assert.deepEqual(await callAzureDevOps(config, "/expiry", { cacheTtlMs: 1000 }), { value: 2 });
    await callAzureDevOps(config, "/uncached");
    await callAzureDevOps(config, "/uncached");
    assert.equal(calls, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("stdio server discovers tool schemas and enforces read-only mode", { timeout: 15000 }, async () => {
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
    env: { AZURE_DEVOPS_READ_ONLY: "1", AZURE_DEVOPS_METRICS: "1" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(!tools.some((tool) => tool.name === "update_work_item"));
    const query = tools.find((tool) => tool.name === "query_work_items");
    assert.equal(query.inputSchema.properties.maxResults.maximum, 5000);
    assert.equal(query.annotations.readOnlyHint, true);
    const result = await client.callTool({ name: "update_work_item", arguments: { id: 1, changes: { "System.Title": "Not applied" } } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /writes are disabled/);
  } finally {
    await client.close();
  }
  assert.match(stderr, /"event":"azure_devops_tool"/);
  assert.match(stderr, /"requests":0/);
});