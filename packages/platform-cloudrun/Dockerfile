# Reference container for a stateless Loom worker on Cloud Run.
#
# The worker image bundles your flows + effects (the "code by id" the
# ExecutionPackage references) and starts the POST /execute endpoint on $PORT.
# Cloud Run sets $PORT and scales the service to zero between requests; the
# worker keeps NO execution state — it rebuilds from the shared event/snapshot
# stores per request, so scale-to-zero and cold starts are safe.
#
# Provide an entrypoint module (e.g. src/worker/main.ts) that:
#   1. constructs a WorkflowRuntime pointed at your shared stores
#      (Postgres/Cloud SQL event + snapshot stores — NOT local SQLite),
#   2. registers every flow + effect the worker must serve,
#   3. calls startWorkerServer(new LocalWorkerRuntime(runtime)).

FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# App-specific: point this at your compiled worker entrypoint.
CMD ["node", "examples/<your-app>/dist/worker/main.js"]
