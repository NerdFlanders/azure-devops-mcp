export type AzureDevOpsConfig = {
  organizationUrl: string;
  project?: string;
  personalAccessToken: string;
};

export const DEFAULT_API_VERSION = "7.1-preview.3";

export function normalizeOrganizationUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveConfig(args: Record<string, unknown> = {}): AzureDevOpsConfig {
  const organizationUrl =
    typeof args["organizationUrl"] === "string" ? args["organizationUrl"] : process.env.AZURE_DEVOPS_ORG_URL;
  const personalAccessToken =
    typeof args["personalAccessToken"] === "string" ? args["personalAccessToken"] : process.env.AZURE_DEVOPS_PAT;
  const project = typeof args["project"] === "string" ? args["project"] : process.env.AZURE_DEVOPS_PROJECT;

  if (!organizationUrl) {
    throw new Error("Missing Azure DevOps organization URL. Set AZURE_DEVOPS_ORG_URL or pass organizationUrl.");
  }

  if (!personalAccessToken) {
    throw new Error("Missing Azure DevOps PAT. Set AZURE_DEVOPS_PAT or pass personalAccessToken.");
  }

  return {
    organizationUrl: normalizeOrganizationUrl(organizationUrl),
    ...(project !== undefined ? { project } : {}),
    personalAccessToken,
  };
}
