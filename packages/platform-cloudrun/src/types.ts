import type { DispatchMetadata } from "@loom/dispatcher";

/** A Cloud Run instance sizing. `memoryMb` in MiB; `cpu` in vCPU. */
export interface CloudRunConfig {
  cpu: number;
  memoryMb: number;
  /** Max concurrent requests per instance (Cloud Run `--concurrency`). */
  concurrency?: number;
}

/** Maps advisory dispatch hints to a concrete Cloud Run sizing. */
export type SizingPolicy = (meta?: DispatchMetadata) => CloudRunConfig;

/** Fetch a secret value by name (e.g. Secret Manager). */
export interface SecretProvider {
  getSecret(name: string): Promise<string>;
}

/** Mint / propagate a workload identity token for outbound calls. */
export interface IdentityProvider {
  getIdentityToken(audience: string): Promise<string>;
}

export interface LogSink {
  log(entry: Record<string, unknown>): void;
}

export interface MetricSink {
  record(name: string, value: number, labels?: Record<string, string>): void;
}

/**
 * The Cloud Run Platform SPI — everything cloud-specific behind one replaceable
 * adapter (ADR 0001's "Platform SPI"). The core runtime never imports this; only
 * {@link CloudRunWorkerRuntime} does.
 *
 * `resolveEndpoint` is the load-bearing method: given a sizing config it returns
 * the base URL of a Cloud Run service/revision able to serve `POST /execute` at
 * that size (deploying or reusing one as needed). The capability slots
 * (secrets/identity/logs/metrics) keep those concerns isolated per platform.
 */
export interface CloudRunPlatform {
  resolveEndpoint(config: CloudRunConfig): Promise<string>;
  /** Optional teardown hook after a dispatch (Cloud Run scales to zero on its own). */
  release?(endpoint: string): Promise<void>;
  secrets?: SecretProvider;
  identity?: IdentityProvider;
  logs?: LogSink;
  metrics?: MetricSink;
}
