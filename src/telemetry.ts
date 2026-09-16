import { AsyncLocalStorage } from "node:async_hooks";

type Metrics = {
  requests: number;
  responseBytes: number;
  throttles: number;
  retries: number;
  cacheHits: number;
};

const context = new AsyncLocalStorage<Metrics>();

export function recordMetric(name: keyof Metrics, amount = 1): void {
  const metrics = context.getStore();
  if (metrics) metrics[name] += amount;
}

export async function measureTool<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const metrics: Metrics = { requests: 0, responseBytes: 0, throttles: 0, retries: 0, cacheHits: 0 };
  const started = performance.now();
  let success = false;
  return context.run(metrics, async () => {
    try {
      const result = await operation();
      success = true;
      return result;
    } finally {
      if (process.env.AZURE_DEVOPS_METRICS === "1") {
        console.error(JSON.stringify({
          event: "azure_devops_tool", tool: name, success,
          durationMs: Math.round(performance.now() - started), ...metrics,
        }));
      }
    }
  });
}