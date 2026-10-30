# Entitlements

Usage metering and entitlements services for Mozilla.

This is an [Nx](https://nx.dev) monorepo using pnpm and NestJS.

## Apps

| App                   | Port | Purpose                                                                     |
| --------------------- | ---- | --------------------------------------------------------------------------- |
| `api`                 | 3037 | Usage ingest and query, usage grants, heartbeat, version, and Swagger.      |
| `metering-subscriber` | 3038 | Consumes usage events from Pub/Sub, dedupes in Redis, writes to ClickHouse. |
| `metering-sweep`      | n/a  | One pass over active meters that dispatches threshold webhooks, then exits. |
| `metering-metrics`    | n/a  | One pass over swept meters that sends usage gauges to StatsD, then exits.   |

Shared code lives in `libs/`. The domain logic is in `libs/metering`.

## Prerequisites

- Node.js 24.15 or newer, matching `.nvmrc`
- pnpm 12, via corepack 0.36 or newer. Older corepack releases cannot run pnpm 12.
- Docker with Compose v2

```sh
npm install -g corepack@latest
corepack enable
```

## Local development

```sh
pnpm install
./dev.sh up
```

`./dev.sh up` builds the dev image and starts ClickHouse, Redis, and the Firebase emulators for Firestore and Pub/Sub. It then runs the ClickHouse migrations and starts all four apps. The api and subscriber rebuild on file changes, the sweep runs every 60 seconds, and the metrics job runs every 5 minutes.

Run `./dev.sh` with no arguments to list every command. The common ones:

```sh
./dev.sh logs-apps   # follow app logs
./dev.sh infra       # infrastructure only, for integration tests
./dev.sh migrate     # rerun ClickHouse migrations
./dev.sh down        # stop and remove containers
```

The Firebase emulator UI is at http://localhost:9299. Swagger UI is at http://localhost:3037/api-docs.

### Configuration

Apps read configuration only from environment variables. Docker Compose supplies them from two files: the committed `dev.env`, which holds local defaults using compose service hostnames, and the optional, gitignored `dev.local.env`. Values in `dev.local.env` win, so put overrides and secrets there. Restart the affected containers with `./dev.sh restart` after changing either file.

Strapi is not part of the compose stack. To exercise meter lookups, set these in `dev.local.env`:

```sh
STRAPI_CLIENT_CONFIG__GRAPHQL_API_URI=http://host.docker.internal:1337/graphql
STRAPI_CLIENT_CONFIG__API_KEY=YOUR_API_KEY_HERE
```

The `local-rp` client in `dev.env` authenticates metering requests locally with `Authorization: Bearer local-dev-secret`.

## Common tasks

```sh
pnpm nx run-many -t lint
pnpm nx run-many -t typecheck
pnpm nx test-unit metering
pnpm nx test-integration metering           # needs ./dev.sh infra
pnpm jest -c libs/metering/jest.config.ts libs/metering/src/lib/usage.service.spec.ts
pnpm nx run shared-cms:codegen              # needs Strapi credentials
```

## Production image

`Dockerfile.production` builds every app into one image. It has no default command, so each deployment picks its entry point:

```sh
docker build -f Dockerfile.production \
  --build-arg APP_VERSION=v1.2.3 --build-arg GIT_SHA=$(git rev-parse HEAD) \
  -t entitlements .

docker run entitlements node dist/apps/api/main.js
docker run entitlements node dist/apps/metering-subscriber/main.js
docker run entitlements node dist/apps/metering-sweep/main.js
docker run entitlements node dist/apps/metering-metrics/main.js
docker run entitlements node libs/metering/migrations/clickhouse/migrate.mjs
```

The subscriber only consumes messages when `METERING_CONFIG__PUBSUB__CONSUMER_ENABLED=true`.
