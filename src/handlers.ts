import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfig, DEFAULT_API_VERSION, type AzureDevOpsConfig } from "./config.js";
import { callAzureDevOps, callAzureDevOpsPage, buildFieldOperations, queryProjectItems, queryWorkItems, type QueryOptions } from "./client.js";
import { measureTool } from "./telemetry.js";
import { isWriteTool, TOOLS } from "./tools.js";

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function asText(value: unknown): string {
  return JSON.stringify(value);
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`'${key}' is required and must be a non-empty string`);
  }
  return value;
}

function requireNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(number)) {
    throw new Error(`'${key}' is required and must be a valid number`);
  }
  return Number(number);
}

function wiqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function optionalStrings(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`'${key}' must be a non-empty array of strings`);
  }
  return value as string[];
}

function queryOptions(input: Record<string, unknown>): QueryOptions {
  const fields = optionalStrings(input, "fields");
  return {
    includeDetails: input["includeDetails"] === true,
    ...(fields ? { fields } : {}),
    ...(input["maxResults"] !== undefined ? { maxResults: requireNumber(input, "maxResults") } : {}),
  };
}

function pageSize(input: Record<string, unknown>): number {
  const size = input["pageSize"] === undefined ? 100 : requireNumber(input, "pageSize");
  if (!Number.isInteger(size) || size < 1 || size > 200) throw new Error("'pageSize' must be an integer between 1 and 200");
  return size;
}

function continuation(input: Record<string, unknown>): string | undefined {
  return input["continuationToken"] === undefined ? undefined : requireString(input, "continuationToken");
}

async function queryResponse(config: AzureDevOpsConfig, project: string, query: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const result = await queryWorkItems(config, project, query, queryOptions(input));
  return text(asText(input["includeDetails"] === true ? result : {
    ...result, ids: result.items.map((item) => item.id), items: [],
  }));
}

function teamPath(project: string, team?: string): string {
  return `/${encodeURIComponent(project)}${team ? `/${encodeURIComponent(team)}` : ""}`;
}

async function teamFilter(config: AzureDevOpsConfig, project: string, input: Record<string, unknown>): Promise<string> {
  if (input["team"] === undefined) return "";
  const team = requireString(input, "team");
  const settings = await callAzureDevOps<{
    field?: { referenceName?: string };
    values?: Array<{ value: string; includeChildren: boolean }>;
  }>(config, `${teamPath(project, team)}/_apis/work/teamsettings/teamfieldvalues`, {
    query: { "api-version": "7.1" }, cacheTtlMs: 60000,
  });
  if (settings.field?.referenceName !== "System.AreaPath" || !settings.values?.length) {
    throw new Error("Team area-path configuration is missing or unsupported; refusing an unscoped query");
  }
  return ` AND (${settings.values.map((area) =>
    `[System.AreaPath] ${area.includeChildren ? "UNDER" : "="} '${wiqlEscape(area.value)}'`
  ).join(" OR ")})`;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  return measureTool(TOOLS.some((tool) => tool.name === name) ? name : "unknown", async () => {
    if (process.env.AZURE_DEVOPS_READ_ONLY === "1" && isWriteTool(name)) {
      throw new Error("Work item writes are disabled by AZURE_DEVOPS_READ_ONLY");
    }
    return dispatchToolCall(name, args);
  });
}

async function dispatchToolCall(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const input = (args ?? {}) as Record<string, unknown>;

  switch (name) {
    case "ping": {
      const message = typeof input["message"] === "string" ? input["message"] : "pong";
      return text(`ping ok: ${message}`);
    }
    case "list_projects": {
      const config = resolveConfig(input);
      const limit = pageSize(input);
      const response = await callAzureDevOpsPage<{ value?: any[] }>(config, "/_apis/projects", {
        query: { "api-version": "7.1", $top: limit, continuationToken: continuation(input) },
        cacheTtlMs: 60000,
      });
      const items = response.data.value ?? [];
      return text(asText({ items, count: items.length, limit, hasMore: !!response.continuationToken, continuationToken: response.continuationToken ?? null }));
    }
    case "get_work_item": {
      const id = Number(input["id"]);
      if (!Number.isFinite(id)) {
        throw new Error("'id' must be a valid number");
      }
      const config = resolveConfig(input);
      const response = await callAzureDevOps<any>(config, `/_apis/wit/workitems/${id}`, {
        query: {
          "api-version": DEFAULT_API_VERSION,
          $expand: typeof input["expand"] === "string" ? input["expand"] : "all",
        },
      });
      return text(asText(response));
    }
    case "create_work_item": {
      const type = typeof input["type"] === "string" ? input["type"] : "Task";
      const title = typeof input["title"] === "string" ? input["title"] : "New work item";
      const project = typeof input["project"] === "string" ? input["project"] : undefined;
      if (!project) {
        throw new Error("'project' is required to create a work item");
      }
      const config = resolveConfig({ ...input, project });
      const fields = (input["fields"] as Record<string, unknown> | undefined) ?? {};
      const operations = [
        { op: "add", path: "/fields/System.Title", value: title },
        ...buildFieldOperations(fields),
      ];

      const response = await callAzureDevOps<any>(config, `/${project}/_apis/wit/workitems/$${type}`, {
        method: "POST",
        query: { "api-version": "7.1-preview.3" },
        body: operations,
        headers: { "Content-Type": "application/json-patch+json" },
      });

      return text(asText(response));
    }
    case "update_work_item": {
      const id = Number(input["id"]);
      if (!Number.isFinite(id)) {
        throw new Error("'id' must be a valid number");
      }
      const changes = (input["changes"] as Record<string, unknown> | undefined) ?? {};
      if (Object.keys(changes).length === 0) {
        throw new Error("'changes' must include at least one field to update");
      }
      const config = resolveConfig(input);
      const operations = buildFieldOperations(changes);

      const response = await callAzureDevOps<any>(config, `/_apis/wit/workitems/${id}`, {
        method: "PATCH",
        query: { "api-version": "7.1-preview.3" },
        body: operations,
        headers: { "Content-Type": "application/json-patch+json" },
      });

      return text(asText(response));
    }
    case "query_work_items": {
      const project = typeof input["project"] === "string" ? input["project"] : undefined;
      if (!project) {
        throw new Error("'project' is required for WIQL queries");
      }
      const wiql =
        typeof input["query"] === "string"
          ? input["query"]
          : `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlEscape(project)}'`;
      const config = resolveConfig({ ...input, project });
      return queryResponse(config, project, wiql, input);
    }
    case "get_work_item_stats": {
      const project = typeof input["project"] === "string" ? input["project"] : undefined;
      if (!project) {
        throw new Error("'project' is required to gather statistics");
      }
      const config = resolveConfig({ ...input, project });
      const scope = await teamFilter(config, project, input);
      const sprint = input["sprint"] === undefined ? undefined : requireString(input, "sprint");
      const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlEscape(project)}'${scope}${sprint ? ` AND [System.IterationPath] = '${wiqlEscape(sprint)}'` : ""}`;
      const items = await queryProjectItems(config, project, query, {
        ...queryOptions(input), includeDetails: true,
        fields: ["System.State", "System.WorkItemType", "Microsoft.VSTS.Common.Priority"],
      });

      const summary = {
        total: items.length,
        byState: {} as Record<string, number>,
        byType: {} as Record<string, number>,
        byPriority: {} as Record<string, number>,
      };

      for (const item of items) {
        const state = String(item.fields?.["System.State"] ?? "Unknown");
        const type = String(item.fields?.["System.WorkItemType"] ?? "Unknown");
        const priority = String(item.fields?.["Microsoft.VSTS.Common.Priority"] ?? "Unknown");

        summary.byState[state] = (summary.byState[state] ?? 0) + 1;
        summary.byType[type] = (summary.byType[type] ?? 0) + 1;
        summary.byPriority[priority] = (summary.byPriority[priority] ?? 0) + 1;
      }

      return text(asText(summary));
    }
    case "get_team_iterations":
    case "get_team_sprints": {
      const project = requireString(input, "project");
      const config = resolveConfig({ ...input, project });
      const team = typeof input["team"] === "string" ? input["team"] : undefined;
      const path = `${teamPath(project, team)}/_apis/work/teamsettings/iterations`;
      const response = await callAzureDevOps<{ value?: any[] }>(config, path, {
        query: { "api-version": "7.1" }, cacheTtlMs: 60000,
      });
      return text(asText(response.value ?? response));
    }
    case "get_sprint_work_items": {
      const project = requireString(input, "project");
      const sprint = requireString(input, "sprint");
      const config = resolveConfig({ ...input, project });
      const scope = await teamFilter(config, project, input);
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlEscape(project)}' AND [System.IterationPath] = '${wiqlEscape(sprint)}'${scope} ORDER BY [System.ChangedDate] DESC`;
      return queryResponse(config, project, wiql, input);
    }
    case "get_board_columns": {
      const project = requireString(input, "project");
      const config = resolveConfig({ ...input, project });
      const board = typeof input["board"] === "string" ? input["board"] : undefined;
      const team = typeof input["team"] === "string" ? input["team"] : undefined;
      const path = board
        ? `${teamPath(project, team)}/_apis/work/boards/${encodeURIComponent(board)}/columns`
        : `${teamPath(project, team)}/_apis/work/boards`;
      const response = await callAzureDevOps<{ value?: any[] }>(config, path, {
        query: { "api-version": "7.1" }, cacheTtlMs: 60000,
      });
      return text(asText(response.value ?? response));
    }
    case "get_sprint_burndown": {
      const project = requireString(input, "project");
      const sprint = typeof input["sprint"] === "string" ? input["sprint"] : undefined;
      const config = resolveConfig({ ...input, project });
      const path = sprint
        ? `/${project}/_apis/work/iterations/${encodeURIComponent(sprint)}/burndown`
        : `/${project}/_apis/work/iterations/burndown`;
      const response = await callAzureDevOps<any>(config, path, {
        query: { "api-version": "7.1-preview.1" },
      });
      return text(asText(response));
    }
    case "get_work_item_relations": {
      const id = requireNumber(input, "id");
      const config = resolveConfig({ ...input, ...(typeof input["project"] === "string" ? { project: input["project"] } : {}) });
      const response = await callAzureDevOps<any>(config, `/_apis/wit/workitems/${id}`, {
        query: { "api-version": DEFAULT_API_VERSION, $expand: "all" },
      });
      return text(asText(response.relations ?? response));
    }
    case "get_work_item_history": {
      const id = requireNumber(input, "id");
      const config = resolveConfig({ ...input, ...(typeof input["project"] === "string" ? { project: input["project"] } : {}) });
      const limit = pageSize(input);
      const skip = input["skip"] === undefined ? 0 : requireNumber(input, "skip");
      if (!Number.isSafeInteger(skip) || skip < 0) throw new Error("'skip' must be a non-negative integer");
      const response = await callAzureDevOps<any>(config, `/_apis/wit/workItems/${id}/revisions`, {
        query: { "api-version": "7.1", $top: limit + 1, $skip: skip },
      });
      const items = (response.value ?? []).slice(0, limit);
      const hasMore = (response.value ?? []).length > limit;
      return text(asText({ items, count: items.length, limit, hasMore, nextSkip: hasMore ? skip + items.length : null }));
    }
    case "get_work_item_comments": {
      const id = requireNumber(input, "id");
      const config = resolveConfig({ ...input, ...(typeof input["project"] === "string" ? { project: input["project"] } : {}) });
      const project = requireString({ project: config.project }, "project");
      const limit = pageSize(input);
      const response = await callAzureDevOpsPage<{ comments?: any[]; continuationToken?: string }>(config, `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments`, {
        query: { "api-version": "7.1-preview.4", $top: limit, continuationToken: continuation(input) },
      });
      const items = response.data.comments ?? [];
      const token = response.data.continuationToken || response.continuationToken || null;
      return text(asText({ items, count: items.length, limit, hasMore: !!token, continuationToken: token }));
    }
    case "query_work_items_by_assignee": {
      const project = requireString(input, "project");
      const assignee = requireString(input, "assignee");
      const config = resolveConfig({ ...input, project });
      const scope = await teamFilter(config, project, input);
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlEscape(project)}' AND [System.AssignedTo] = '${wiqlEscape(assignee)}'${scope} ORDER BY [System.ChangedDate] DESC`;
      return queryResponse(config, project, wiql, input);
    }
    case "query_work_items_by_state": {
      const project = requireString(input, "project");
      const state = requireString(input, "state");
      const config = resolveConfig({ ...input, project });
      const scope = await teamFilter(config, project, input);
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlEscape(project)}' AND [System.State] = '${wiqlEscape(state)}'${scope} ORDER BY [System.ChangedDate] DESC`;
      return queryResponse(config, project, wiql, input);
    }
    case "query_work_items_by_tag": {
      const project = requireString(input, "project");
      const tag = requireString(input, "tag");
      const config = resolveConfig({ ...input, project });
      const scope = await teamFilter(config, project, input);
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlEscape(project)}' AND [System.Tags] CONTAINS '${wiqlEscape(tag)}'${scope} ORDER BY [System.ChangedDate] DESC`;
      return queryResponse(config, project, wiql, input);
    }
    case "get_team_velocity": {
      const project = requireString(input, "project");
      const team = requireString(input, "team");
      const sprint = requireString(input, "sprint");
      const config = resolveConfig({ ...input, project });
      const [scope, backlog] = await Promise.all([
        teamFilter(config, project, input),
        callAzureDevOps<{
          backlogFields?: { typeFields?: Record<string, string> };
          requirementBacklog?: { workItemTypes?: Array<{ name: string }> };
          workItemTypeMappedStates?: Array<{ workItemTypeName: string; states: Record<string, string> }>;
          bugsBehavior?: string;
        }>(config, `${teamPath(project, team)}/_apis/work/backlogconfiguration`, {
          query: { "api-version": "7.1" }, cacheTtlMs: 60000,
        }),
      ]);
      const effortField = input["effortField"] === undefined
        ? backlog.backlogFields?.typeFields?.["Effort"] : requireString(input, "effortField");
      if (!effortField || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(effortField)) {
        throw new Error("No valid effort field mapping; supply 'effortField' explicitly");
      }
      const defaultTypes = (backlog.requirementBacklog?.workItemTypes ?? []).map((type) => type.name);
      if (backlog.bugsBehavior === "asRequirements" && !defaultTypes.includes("Bug")) defaultTypes.push("Bug");
      const types = optionalStrings(input, "workItemTypes") ?? defaultTypes.filter((type) => type !== "Bug" || backlog.bugsBehavior === "asRequirements");
      if (!types.length) throw new Error("No requirement work item types; supply 'workItemTypes' explicitly");
      const stateOverride = optionalStrings(input, "completedStates");
      const completedStatesByType: Record<string, string[]> = Object.create(null);
      const clauses = types.map((type) => {
        const mapping = backlog.workItemTypeMappedStates?.find((entry) => entry.workItemTypeName === type)?.states ?? {};
        const states = stateOverride ?? Object.entries(mapping).filter(([, category]) => category === "Completed").map(([state]) => state);
        if (!states.length) throw new Error(`No completed states for '${type}'; supply 'completedStates' explicitly`);
        completedStatesByType[type] = states;
        return `([System.WorkItemType] = '${wiqlEscape(type)}' AND [System.State] IN (${states.map((state) => `'${wiqlEscape(state)}'`).join(", ")}))`;
      });
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlEscape(project)}' AND [System.IterationPath] = '${wiqlEscape(sprint)}'${scope} AND (${clauses.join(" OR ")})`;
      const items = await queryProjectItems(config, project, wiql, {
        ...queryOptions(input), includeDetails: true, fields: [effortField],
      });
      let total = 0;
      let missingEstimateCount = 0;
      for (const item of items) {
        const estimate = item.fields?.[effortField];
        if (estimate === undefined || estimate === null || estimate === "") {
          missingEstimateCount += 1;
        } else if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0) {
          throw new Error(`Work item ${item.id} has an invalid effort value`);
        } else {
          total += estimate;
        }
      }
      return text(asText({
        project, team, sprint, effortField, completedStatesByType, workItemTypes: types,
        totalCompletedEffort: total, count: items.length, missingEstimateCount,
        ...(effortField === "Microsoft.VSTS.Scheduling.StoryPoints" ? { totalCompletedStoryPoints: total } : {}),
        basis: "Current completed items assigned to this sprint, not a historical sprint-end snapshot",
      }));
    }
    case "list_pull_requests": {
      const project = requireString(input, "project");
      const config = resolveConfig({ ...input, project });
      const repositoryId = typeof input["repositoryId"] === "string" ? input["repositoryId"] : undefined;
      const status = typeof input["status"] === "string" ? input["status"] : undefined;
      const path = repositoryId
        ? `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests`
        : `/${project}/_apis/git/pullrequests`;
      const response = await callAzureDevOps<{ value?: any[] }>(config, path, {
        query: {
          "api-version": "7.1-preview.3",
          ...(status ? { searchCriteria: JSON.stringify({ status }) } : {}),
        },
      });
      return text(asText(response.value ?? response));
    }
    case "get_pull_request": {
      const project = requireString(input, "project");
      const repositoryId = requireString(input, "repositoryId");
      const pullRequestId = requireNumber(input, "pullRequestId");
      const config = resolveConfig({ ...input, project });
      const response = await callAzureDevOps<any>(config, `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}`, {
        query: { "api-version": "7.1-preview.3" },
      });
      return text(asText(response));
    }
    case "get_pull_request_comments": {
      const project = requireString(input, "project");
      const repositoryId = requireString(input, "repositoryId");
      const pullRequestId = requireNumber(input, "pullRequestId");
      const config = resolveConfig({ ...input, project });
      const response = await callAzureDevOps<any>(config, `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}/threads`, {
        query: { "api-version": "7.1-preview.1" },
      });
      return text(asText(response.value ?? response));
    }
    case "get_pipeline_runs": {
      const project = requireString(input, "project");
      const config = resolveConfig({ ...input, project });
      const definitionId = typeof input["definitionId"] === "number" ? input["definitionId"] : undefined;
      const statusFilter = typeof input["statusFilter"] === "string" ? input["statusFilter"] : undefined;
      const limit = pageSize(input);
      const response = await callAzureDevOpsPage<{ value?: any[] }>(config, `/${encodeURIComponent(project)}/_apis/build/builds`, {
        query: {
          "api-version": "7.1", $top: limit, continuationToken: continuation(input),
          ...(definitionId ? { definitions: String(definitionId) } : {}),
          ...(statusFilter ? { statusFilter } : {}),
        },
      });
      const items = response.data.value ?? [];
      return text(asText({ items, count: items.length, limit, hasMore: !!response.continuationToken, continuationToken: response.continuationToken ?? null }));
    }
    case "get_release_status": {
      const project = requireString(input, "project");
      const config = resolveConfig({ ...input, project });
      const environmentName = typeof input["environmentName"] === "string" ? input["environmentName"] : undefined;
      const response = await callAzureDevOps<any>(config, `/${project}/_apis/release/releases`, {
        query: {
          "api-version": "7.1-preview.8",
          ...(environmentName ? { environmentName } : {}),
        },
      });
      return text(asText(response.value ?? response));
    }
    case "get_recent_failures": {
      const project = requireString(input, "project");
      const config = resolveConfig({ ...input, project });
      const top = typeof input["top"] === "number" ? input["top"] : 10;
      const response = await callAzureDevOps<{ value?: any[] }>(config, `/${project}/_apis/build/builds`, {
        query: {
          "api-version": "7.1-preview.7",
          statusFilter: "completed",
          resultFilter: "failed",
          $top: String(top),
        },
      });
      const failures = Array.isArray(response.value) ? response.value : Array.isArray(response) ? response : [];
      return text(asText(failures.slice(0, top)));
    }
    case "get_test_results": {
      const project = requireString(input, "project");
      const config = resolveConfig({ ...input, project });
      const runId = typeof input["runId"] === "number" ? input["runId"] : undefined;
      const path = runId ? `/${project}/_apis/test/runs/${runId}/results` : `/${project}/_apis/test/runs`;
      const response = await callAzureDevOps<any>(config, path, {
        query: { "api-version": "7.1-preview.1" },
      });
      return text(asText(response.value ?? response));
    }
    case "get_failed_tests": {
      const project = requireString(input, "project");
      const config = resolveConfig({ ...input, project });
      const runId = typeof input["runId"] === "number" ? input["runId"] : undefined;
      const path = runId ? `/${project}/_apis/test/runs/${runId}/results` : `/${project}/_apis/test/runs`;
      const response = await callAzureDevOps<any>(config, path, {
        query: { "api-version": "7.1-preview.1" },
      });
      const items = Array.isArray(response.value) ? response.value : Array.isArray(response) ? response : [];
      const failed = items.filter((item: any) => item.outcome === "Failed" || item.outcome === "NotExecuted");
      return text(asText(failed));
    }
    case "query_test_cases": {
      const project = requireString(input, "project");
      const title = typeof input["title"] === "string" ? input["title"] : undefined;
      const config = resolveConfig({ ...input, project });
      const scope = await teamFilter(config, project, input);
      const wiql = title
        ? `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlEscape(project)}' AND [System.WorkItemType] = 'Test Case' AND [System.Title] CONTAINS '${wiqlEscape(title)}'${scope} ORDER BY [System.ChangedDate] DESC`
        : `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${wiqlEscape(project)}' AND [System.WorkItemType] = 'Test Case'${scope} ORDER BY [System.ChangedDate] DESC`;
      return queryResponse(config, project, wiql, input);
    }
    case "search_code": {
      const project = requireString(input, "project");
      const searchText = requireString(input, "searchText");
      const config = resolveConfig({ ...input, project });
      const repositoryId = typeof input["repositoryId"] === "string" ? input["repositoryId"] : undefined;
      const repositoryPath = repositoryId ? `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items` : `/${project}/_apis/git/repositories`;
      const response = await callAzureDevOps<any>(config, repositoryPath, {
        query: {
          "api-version": "7.1-preview.1",
          includeContentMetadata: true,
          includeLinks: true,
          scopePath: "/",
          searchCriteria: JSON.stringify({ searchText }),
        },
      });
      return text(asText(response));
    }
    case "get_changed_files": {
      const project = requireString(input, "project");
      const repositoryId = requireString(input, "repositoryId");
      const config = resolveConfig({ ...input, project });
      const pullRequestId = typeof input["pullRequestId"] === "number" ? input["pullRequestId"] : undefined;
      const commitId = typeof input["commitId"] === "string" ? input["commitId"] : undefined;
      if (pullRequestId !== undefined) {
        const response = await callAzureDevOps<any>(config, `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/iterations`, {
          query: { "api-version": "7.1-preview.1" },
        });
        return text(asText(response.value ?? response));
      }
      if (commitId) {
        const response = await callAzureDevOps<any>(config, `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits/${encodeURIComponent(commitId)}`, {
          query: { "api-version": "7.1-preview.1" },
        });
        return text(asText(response));
      }
      throw new Error("Either 'pullRequestId' or 'commitId' must be provided");
    }
    case "get_commit_history": {
      const project = requireString(input, "project");
      const repositoryId = requireString(input, "repositoryId");
      const config = resolveConfig({ ...input, project });
      const top = typeof input["top"] === "number" ? input["top"] : 20;
      const response = await callAzureDevOps<any>(config, `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits`, {
        query: { "api-version": "7.1-preview.1", $top: String(top) },
      });
      return text(asText(response.value ?? response));
    }
    case "get_file_contents": {
      const project = requireString(input, "project");
      const repositoryId = requireString(input, "repositoryId");
      const path = requireString(input, "path");
      const config = resolveConfig({ ...input, project });
      const branch = typeof input["branch"] === "string" ? input["branch"] : "main";
      const response = await callAzureDevOps<any>(config, `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items`, {
        query: {
          "api-version": "7.1-preview.1",
          path,
          versionDescriptor: JSON.stringify({ version: branch, versionType: "branch" }),
          includeContent: true,
        },
      });
      return text(asText(response));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
