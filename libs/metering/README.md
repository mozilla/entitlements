# metering

Usage metering for entitlements: usage ingest and query endpoints, usage grants, the Pub/Sub consumer that writes events to ClickHouse, the threshold sweep that dispatches webhooks, and the metrics job that sends usage gauges to StatsD.

## Running unit tests

Run `nx test-unit metering` to execute the unit tests via [Jest](https://jestjs.io).

## Running integration tests

Run `nx test-integration metering`. The `*.in.spec.ts` suites need ClickHouse and Redis from `./dev.sh infra`.

## Running the threshold sweep

`metering-sweep` does one pass over every active meter on `METERING_SWEEP_SCHEDULER_CONFIG__CRON`, every minute by default. `@nestjs/locks` runs it on one instance at a time, with its locks in Redis.

## Usage counters in Redis

The usage endpoint reads usage from counters in Redis, which the subscriber updates as it stores events. When Redis is not fully populated, the endpoint sums usage in ClickHouse instead, up to `maxUsageFallbackReadsPerSecond`, and returns 503 above that.

Run Redis with `maxmemory-policy noeviction`, because a missing counter reads as zero usage.

Each sweep run starts by checking the counters. It rebuilds them from ClickHouse when Redis is empty, after a Redis failover, or when a meter's window changes, and the subscriber pauses while it does.

Sliding windows are counted in whole hours, so their duration must be a multiple of 60 minutes.

## Running the metrics job

`metering-metrics` sends usage gauges for every meter the sweep has seen on `METERING_METRICS_SCHEDULER_CONFIG__CRON`, every 5 minutes by default, on one instance at a time. For each meter it reports the limit, the subjects with usage today (UTC), and the subjects notified at each threshold in the current window.
