import type {
  CloudRunConfig,
  CloudRunPlatform,
  IdentityProvider,
  LogSink,
  MetricSink,
  SecretProvider,
} from "./types";

export interface StaticCloudRunPlatformOptions {
  secrets?: SecretProvider;
  identity?: IdentityProvider;
  logs?: LogSink;
  metrics?: MetricSink;
}

/**
 * The simplest real {@link CloudRunPlatform}: a single already-deployed service
 * URL, returned for every sizing config. Use this when you manage one Cloud Run
 * service out-of-band (e.g. via `gcloud run deploy` + Terraform) and just want
 * Loom to invoke it. Swap for a deploy-per-size adapter when you want the
 * runtime to provision revisions itself.
 */
export class StaticCloudRunPlatform implements CloudRunPlatform {
  readonly secrets?: SecretProvider;
  readonly identity?: IdentityProvider;
  readonly logs?: LogSink;
  readonly metrics?: MetricSink;

  constructor(
    private readonly endpoint: string,
    options: StaticCloudRunPlatformOptions = {}
  ) {
    if (options.secrets) this.secrets = options.secrets;
    if (options.identity) this.identity = options.identity;
    if (options.logs) this.logs = options.logs;
    if (options.metrics) this.metrics = options.metrics;
  }

  async resolveEndpoint(_config: CloudRunConfig): Promise<string> {
    return this.endpoint;
  }
}
