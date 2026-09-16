import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const resultLimit = { type: "integer", minimum: 1, maximum: 5000, default: 1000, description: "Maximum matching items. Results include hasMore; aggregates reject incomplete results." };
const queryProperties = {
  maxResults: resultLimit,
  fields: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "Fields to fetch when includeDetails is true." },
};
const teamProperty = { type: "string", minLength: 1, description: "Team name or ID; filters by configured team area paths, including child areas where configured." };
const pageSizeProperty = { type: "integer", minimum: 1, maximum: 200, default: 100, description: "Maximum items in this page" };
const pageProperties = {
  pageSize: pageSizeProperty,
  continuationToken: { type: "string", description: "Opaque token from the previous response; reuse the same filters" },
};
const writeTools = new Set(["create_work_item", "update_work_item"]);

export function isWriteTool(name: string): boolean {
  return writeTools.has(name);
}

export function getAvailableTools(): Tool[] {
  return process.env.AZURE_DEVOPS_READ_ONLY === "1" ? TOOLS.filter((tool) => !isWriteTool(tool.name)) : TOOLS;
}

export const TOOLS: Tool[] = [
  {
    name: "list_projects",
    description: "List one page of Azure DevOps projects visible to the configured PAT. Follow continuationToken when hasMore is true.",
    inputSchema: {
      type: "object",
      properties: {
        ...pageProperties,
        organizationUrl: {
          type: "string",
          description: "Azure DevOps organization URL, e.g. https://dev.azure.com/your-org",
        },
        personalAccessToken: {
          type: "string",
          description: "Azure DevOps PAT. If omitted, AZURE_DEVOPS_PAT env var is used.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_work_item",
    description: "Retrieve a single Azure DevOps work item with all fields.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Work item ID" },
        organizationUrl: { type: "string" },
        project: { type: "string", description: "Optional project name used as default context" },
        personalAccessToken: { type: "string" },
        expand: { type: "string", description: "Optional expansion mode such as all, relations, fields" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_work_item",
    description: "Create a new Azure DevOps work item, such as a User Story, Task, or Bug.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Work item type, such as Task, User Story, Bug" },
        title: { type: "string", description: "Work item title" },
        fields: {
          type: "object",
          description: "Optional field map with Azure DevOps field names such as System.State, Microsoft.VSTS.Common.Priority",
          additionalProperties: true,
        },
        organizationUrl: { type: "string" },
        project: { type: "string", description: "Project that the work item belongs to" },
        personalAccessToken: { type: "string" },
      },
      required: ["type", "title", "project"],
      additionalProperties: false,
    },
  },
  {
    name: "update_work_item",
    description: "Update an Azure DevOps work item using JSON patch operations.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Work item ID" },
        changes: {
          type: "object",
          description: "Field/value map, for example {\"System.State\": \"Active\", \"System.Title\": \"Updated title\"}",
          additionalProperties: true,
        },
        organizationUrl: { type: "string" },
        project: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["id", "changes"],
      additionalProperties: false,
    },
  },
  {
    name: "query_work_items",
    description: "Run a WIQL query and optionally resolve the returned item ids into full work items.",
    inputSchema: {
      type: "object",
      properties: {
        ...queryProperties,
        project: { type: "string", description: "Azure DevOps project name" },
        query: { type: "string", description: "WIQL query to execute" },
        includeDetails: { type: "boolean", description: "Whether to resolve the matching work item IDs into full details" },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Optional field names to include when resolving details.",
        },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_work_item_stats",
    description: "Return aggregate work item statistics for a project, including counts by state, type, and priority.",
    inputSchema: {
      type: "object",
      properties: {
        team: teamProperty,
        sprint: { type: "string", description: "Optional full iteration path" },
        maxResults: resultLimit,
        project: { type: "string", description: "Azure DevOps project name" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_team_iterations",
    description: "List Azure DevOps iterations for a project and optional team.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        team: { type: "string", description: "Optional team name. If omitted, the project's default team is used." },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_team_sprints",
    description: "List sprint/iteration metadata for a team or project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        team: { type: "string", description: "Optional team name" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sprint_work_items",
    description: "List work items assigned to a specific sprint or iteration path.",
    inputSchema: {
      type: "object",
      properties: {
        ...queryProperties,
        team: teamProperty,
        project: { type: "string", description: "Azure DevOps project name" },
        sprint: { type: "string", description: "Sprint or iteration path, e.g. Project\\Sprint 1" },
        includeDetails: { type: "boolean", description: "Whether to resolve full work item details" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "sprint"],
      additionalProperties: false,
    },
  },
  {
    name: "get_board_columns",
    description: "List Azure DevOps board columns and state mappings.",
    inputSchema: {
      type: "object",
      properties: {
        team: teamProperty,
        project: { type: "string", description: "Azure DevOps project name" },
        board: { type: "string", description: "Optional board name" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sprint_burndown",
    description: "Get sprint burndown or iteration trend data for a team or project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        sprint: { type: "string", description: "Sprint or iteration identifier or path" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_work_item_relations",
    description: "Retrieve parent-child or dependency relations for a work item.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Work item ID" },
        organizationUrl: { type: "string" },
        project: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_work_item_history",
    description: "Get one page of work item revisions. Pass nextSkip as skip to read the next page.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: pageSizeProperty,
        skip: { type: "integer", minimum: 0, default: 0, description: "Revisions to skip" },
        id: { type: "number", description: "Work item ID" },
        organizationUrl: { type: "string" },
        project: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_work_item_comments",
    description: "Get one page of discussion comments. Follow continuationToken when hasMore is true. Requires project or AZURE_DEVOPS_PROJECT.",
    inputSchema: {
      type: "object",
      properties: {
        ...pageProperties,
        id: { type: "number", description: "Work item ID" },
        organizationUrl: { type: "string" },
        project: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "query_work_items_by_assignee",
    description: "Query work items assigned to a specific person.",
    inputSchema: {
      type: "object",
      properties: {
        ...queryProperties,
        team: teamProperty,
        project: { type: "string", description: "Azure DevOps project name" },
        assignee: { type: "string", description: "Assignee display name or email" },
        includeDetails: { type: "boolean", description: "Whether to resolve full work item details" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "assignee"],
      additionalProperties: false,
    },
  },
  {
    name: "query_work_items_by_state",
    description: "Query work items by a given Azure DevOps state.",
    inputSchema: {
      type: "object",
      properties: {
        ...queryProperties,
        team: teamProperty,
        project: { type: "string", description: "Azure DevOps project name" },
        state: { type: "string", description: "Work item state, such as Active, New, Closed" },
        includeDetails: { type: "boolean", description: "Whether to resolve full work item details" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "state"],
      additionalProperties: false,
    },
  },
  {
    name: "query_work_items_by_tag",
    description: "Query work items with a specific tag.",
    inputSchema: {
      type: "object",
      properties: {
        ...queryProperties,
        team: teamProperty,
        project: { type: "string", description: "Azure DevOps project name" },
        tag: { type: "string", description: "Tag value to search for" },
        includeDetails: { type: "boolean", description: "Whether to resolve full work item details" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "tag"],
      additionalProperties: false,
    },
  },
  {
    name: "get_team_velocity",
    description: "Sum current completed requirement effort for one team and sprint using process metadata. Not a historical sprint-end snapshot. Refuses partial aggregates.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        sprint: { type: "string", minLength: 1, description: "Full iteration path" },
        team: teamProperty,
        maxResults: resultLimit,
        effortField: { type: "string", description: "Override the process effort field reference name" },
        completedStates: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "Override completed states for all selected types" },
        workItemTypes: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "Override requirement backlog types" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "team", "sprint"],
      additionalProperties: false,
    },
  },
  {
    name: "list_pull_requests",
    description: "List pull requests for a repository or project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        repositoryId: { type: "string", description: "Optional repository ID or name" },
        status: { type: "string", description: "Optional PR status filter" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_pull_request",
    description: "Get a single pull request and its metadata.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        repositoryId: { type: "string", description: "Repository ID or name" },
        pullRequestId: { type: "number", description: "Pull request ID" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "repositoryId", "pullRequestId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_pull_request_comments",
    description: "Get pull request review threads and comments.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        repositoryId: { type: "string", description: "Repository ID or name" },
        pullRequestId: { type: "number", description: "Pull request ID" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "repositoryId", "pullRequestId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_pipeline_runs",
    description: "List one page of Azure Pipelines runs for a project and optional definition. Follow continuationToken when hasMore is true.",
    inputSchema: {
      type: "object",
      properties: {
        ...pageProperties,
        project: { type: "string", description: "Azure DevOps project name" },
        definitionId: { type: "number", description: "Optional pipeline definition ID" },
        statusFilter: { type: "string", description: "Optional status filter such as completed, inProgress" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_release_status",
    description: "Get Azure DevOps release information for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        environmentName: { type: "string", description: "Optional environment name filter" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_recent_failures",
    description: "Summarize recent build or release failures in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        top: { type: "number", description: "Maximum number of recent failures to return" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_test_results",
    description: "List Azure DevOps tests and results for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        runId: { type: "number", description: "Optional test run ID" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_failed_tests",
    description: "List failed test results for a project or specific run.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        runId: { type: "number", description: "Optional test run ID" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "query_test_cases",
    description: "Find test case work items in a project.",
    inputSchema: {
      type: "object",
      properties: {
        ...queryProperties,
        team: teamProperty,
        project: { type: "string", description: "Azure DevOps project name" },
        title: { type: "string", description: "Optional title fragment" },
        includeDetails: { type: "boolean", description: "Whether to resolve full work item details" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "search_code",
    description: "Search repository contents for code or symbols.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        repositoryId: { type: "string", description: "Optional repository ID or name" },
        searchText: { type: "string", description: "Text or symbol to search for" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "searchText"],
      additionalProperties: false,
    },
  },
  {
    name: "get_changed_files",
    description: "List changed files for a pull request or commit.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        repositoryId: { type: "string", description: "Repository ID or name" },
        pullRequestId: { type: "number", description: "Optional pull request ID" },
        commitId: { type: "string", description: "Optional commit ID" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "repositoryId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_commit_history",
    description: "Get recent commits in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        repositoryId: { type: "string", description: "Repository ID or name" },
        top: { type: "number", description: "Maximum number of commits to return" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "repositoryId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_file_contents",
    description: "Read a file from a repository at a specific path and revision.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Azure DevOps project name" },
        repositoryId: { type: "string", description: "Repository ID or name" },
        path: { type: "string", description: "Path to the file within the repo" },
        branch: { type: "string", description: "Branch name or ref, default to main" },
        organizationUrl: { type: "string" },
        personalAccessToken: { type: "string" },
      },
      required: ["project", "repositoryId", "path"],
      additionalProperties: false,
    },
  },
];

for (const tool of TOOLS) {
  const write = isWriteTool(tool.name);
  tool.annotations = { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: true };
}
