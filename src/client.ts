import type { AzureDevOpsConfig } from "./config.js";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { recordMetric } from "./telemetry.js";

type RequestOptions = {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  safeToRetry?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  cacheTtlMs?: number;
};

type Page<T> = { data: T; continuationToken?: string };
const metadataCache = new Map<string, { expires: number; page: Page<unknown> }>();

function numericSetting(value: number | string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Request setting must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

class HttpFailure extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs: number | undefined) {
    super(message);
  }
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      recordMetric("responseBytes", chunk.value.byteLength);
      if (size > 10 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Azure DevOps response exceeds 10 MiB; request fewer items or fields");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function callAzureDevOps<T>(
  config: AzureDevOpsConfig,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  return (await callAzureDevOpsPage<T>(config, path, options)).data;
}

export async function callAzureDevOpsPage<T>(
  config: AzureDevOpsConfig,
  path: string,
  options: RequestOptions = {}
): Promise<Page<T>> {
  const url = new URL(`${config.organizationUrl}${path.startsWith("/") ? path : `/${path}`}`);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const requestHeaders: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`:${config.personalAccessToken}`).toString("base64")}`,
    Accept: "application/json",
    ...(options.headers ?? {}),
  };

  if (options.body !== undefined) {
    requestHeaders["Content-Type"] = options.headers?.["Content-Type"] ?? "application/json";
  }

  const requestInit: RequestInit = {
    method: options.method ?? "GET",
    headers: requestHeaders,
  };

  if (options.body !== undefined) {
    requestInit.body = JSON.stringify(options.body);
  }

  const timeoutMs = numericSetting(options.timeoutMs ?? process.env.AZURE_DEVOPS_TIMEOUT_MS, 15000, 1, 120000);
  const maxRetries = numericSetting(options.maxRetries ?? process.env.AZURE_DEVOPS_MAX_RETRIES, 2, 0, 5);
  const cacheTtlMs = numericSetting(options.cacheTtlMs, 0, 0, 300000);
  const method = requestInit.method!.toUpperCase();
  const canRetry = method === "GET" || (method === "POST" && options.safeToRetry === true);
  const cacheKey = method === "GET" && cacheTtlMs > 0
    ? createHash("sha256").update(JSON.stringify([url.href, requestHeaders])).digest("hex")
    : undefined;
  if (cacheKey) {
    const cached = metadataCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      recordMetric("cacheHits");
      return structuredClone(cached.page) as Page<T>;
    }
    metadataCache.delete(cacheKey);
  }

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let waitMs = 0;
    try {
      recordMetric("requests");
      const response = await fetch(url, { ...requestInit, signal: controller.signal, redirect: "error" });
      if (response.status === 429) recordMetric("throttles");
      const rawText = await readResponse(response);
      let payload: any;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        if (response.ok) throw new Error("Azure DevOps returned an invalid JSON response");
      }
      if (!response.ok) {
        const message = payload?.message || payload?.error?.message || response.statusText;
        throw new HttpFailure(`Azure DevOps API request failed (${response.status}): ${message}`, response.status, retryAfter(response.headers));
      }
      const continuationToken = response.headers.get("x-ms-continuationtoken") || undefined;
      const page: Page<T> = { data: payload as T, ...(continuationToken ? { continuationToken } : {}) };
      if (cacheKey && Buffer.byteLength(rawText) <= 256 * 1024) {
        for (const [key, entry] of metadataCache) {
          if (entry.expires <= Date.now()) metadataCache.delete(key);
        }
        if (metadataCache.size >= 100) metadataCache.delete(metadataCache.keys().next().value!);
        metadataCache.set(cacheKey, { expires: Date.now() + cacheTtlMs, page: structuredClone(page) });
      }
      return page;
    } catch (error) {
      const transient = error instanceof HttpFailure
        ? [429, 502, 503, 504].includes(error.status)
        : error instanceof TypeError || controller.signal.aborted;
      waitMs = error instanceof HttpFailure && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : Math.min(30000, 250 * 2 ** attempt + Math.floor(Math.random() * 100));
      if (!canRetry || !transient || attempt >= maxRetries || waitMs > 30000) {
        if (controller.signal.aborted) throw new Error(`Azure DevOps request timed out after ${timeoutMs} ms`);
        throw error;
      }
      recordMetric("retries");
    } finally {
      clearTimeout(timer);
    }
    await delay(waitMs);
  }
}

export function buildFieldOperations(
  changes: Record<string, unknown>
): Array<{ op: string; path: string; value: unknown }> {
  return Object.entries(changes).map(([fieldName, value]) => ({
    op: "add",
    path: `/fields/${fieldName}`,
    value,
  }));
}

export async function queryProjectItems(
  config: AzureDevOpsConfig,
  project: string,
  query: string,
  options: QueryOptions = {}
): Promise<any[]> {
  const result = await queryWorkItems(config, project, query, options);
  if (result.hasMore) {
    throw new Error(`Query exceeds ${result.limit} items. Narrow the query before calculating aggregates.`);
  }
  return result.items;
}

export type QueryOptions = {
  includeDetails?: boolean;
  fields?: string[];
  maxResults?: number;
};

export async function queryWorkItems(
  config: AzureDevOpsConfig,
  project: string,
  query: string,
  options: QueryOptions = {}
): Promise<{ items: any[]; count: number; hasMore: boolean; limit: number }> {
  const limit = options.maxResults ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("'maxResults' must be an integer between 1 and 5000");
  }
  if (options.fields !== undefined && (!Array.isArray(options.fields) || options.fields.length === 0 ||
    options.fields.some((field) => typeof field !== "string" || !field.trim()))) {
    throw new Error("'fields' must be a non-empty array of field names");
  }
  const wiqlResult = await callAzureDevOps<{ workItems?: Array<{ id: number }>; asOf?: string }>(
    config,
    `/${encodeURIComponent(project)}/_apis/wit/wiql`,
    {
      method: "POST",
      query: { "api-version": "7.1", $top: limit + 1 },
      body: { query },
      safeToRetry: true,
    }
  );

  if (!Array.isArray(wiqlResult.workItems)) {
    throw new Error("Only flat WIQL queries returning workItems are supported");
  }
  const references = wiqlResult.workItems.slice(0, limit);
  const hasMore = wiqlResult.workItems.length > limit;
  if (options.includeDetails === false || references.length === 0) {
    return { items: references, count: references.length, hasMore, limit };
  }
  const batches: number[][] = [];
  for (let offset = 0; offset < references.length; offset += 200) {
    batches.push(references.slice(offset, offset + 200).map((item) => item.id));
  }
  const items: any[] = [];
  for (let offset = 0; offset < batches.length; offset += 3) {
    const results = await Promise.all(batches.slice(offset, offset + 3).map((ids) =>
      callAzureDevOps<{ value?: any[] }>(config, `/${encodeURIComponent(project)}/_apis/wit/workitemsbatch`, {
        method: "POST",
        query: { "api-version": "7.1" },
        safeToRetry: true,
        body: {
          ids,
          ...(options.fields ? { fields: options.fields } : {}),
          ...(wiqlResult.asOf ? { asOf: wiqlResult.asOf } : {}),
        },
      })
    ));
    items.push(...results.flatMap((result) => result.value ?? []));
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = references.map((item) => byId.get(item.id));
  if (ordered.some((item) => item === undefined)) {
    throw new Error("Azure DevOps returned incomplete work item details; retry or narrow the query");
  }
  return { items: ordered, count: ordered.length, hasMore, limit };
}
