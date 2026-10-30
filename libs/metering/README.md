# metering

Usage metering for entitlements: usage ingest and query endpoints, usage grants, the Pub/Sub consumer that writes events to ClickHouse, the threshold sweep that dispatches webhooks, and the metrics job that sends usage gauges to StatsD.

## Running unit tests

Run `nx test-unit metering` to execute the unit tests via [Jest](https://jestjs.io).

## Running integration tests

Run `nx test-integration metering`. The `*.in.spec.ts` suites need ClickHouse and Redis from `./dev.sh infra`.

## Running the threshold sweep

Run `nx run metering-sweep:run` to do one pass over every active meter. Locally, `./dev.sh up` runs it every 60 seconds. In production it runs as a Kubernetes CronJob.

## Running the metrics job

Run `nx run metering-metrics:run` to send usage gauges for every meter the sweep has seen. For each meter it reports the limit, the subjects with usage today (UTC), and the subjects notified at each threshold in the current window. Locally, `./dev.sh up` runs it every 5 minutes. In production it runs as a Kubernetes CronJob every 5 minutes.
