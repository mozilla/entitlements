/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'reflect-metadata';

import { RateLimiterMemory } from 'rate-limiter-flexible';

import { StatsD } from '@entitlements/shared/metrics/statsd';

import { ClickHouseClient } from './lib/clickhouse.client';
import { ClickHouseConfig } from './lib/clickhouse.config';
import {
  EVENTS_TABLE,
  NOTIFICATIONS_TABLE,
  SESSIONS_TABLE,
  WATERMARKS_TABLE,
} from './lib/metering.constants';
import type {
  ClickHouseRateLimiters,
  MeteringRedisPipeline,
} from './lib/metering.types';

export interface RecordedRedisCommand {
  command: string;
  args: unknown[];
}

export function recordingRedisPipeline(
  replies: Array<[Error | null, unknown]>,
  commands: RecordedRedisCommand[]
): MeteringRedisPipeline {
  const record =
    (command: string) =>
    (...args: unknown[]) => {
      commands.push({ command, args });
    };
  return {
    set: record('set'),
    get: record('get'),
    del: record('del'),
    hset: record('hset'),
    hmget: record('hmget'),
    hincrby: record('hincrby'),
    expireat: record('expireat'),
    eval: record('eval'),
    exec: () => Promise.resolve(replies),
  };
}

export function rejectingRedisPipeline(err: Error): MeteringRedisPipeline {
  const ignore = () => undefined;
  return {
    set: ignore,
    get: ignore,
    del: ignore,
    hset: ignore,
    hmget: ignore,
    hincrby: ignore,
    expireat: ignore,
    eval: ignore,
    exec: () => Promise.reject(err),
  };
}

export const INTEGRATION_CLICKHOUSE_CONFIG: ClickHouseConfig = {
  url:
    process.env['METERING_CONFIG__CLICKHOUSE__URL'] ?? 'http://127.0.0.1:8124',
  database: process.env['METERING_CONFIG__CLICKHOUSE__DATABASE'] ?? 'metering',
  username:
    process.env['METERING_CONFIG__CLICKHOUSE__USERNAME'] ?? 'metering_rw',
  password:
    process.env['METERING_CONFIG__CLICKHOUSE__PASSWORD'] ??
    'local_metering_dev',
  requestTimeoutMs: 30_000,
  maxExecutionTimeSeconds: 25,
  maxThreads: 2,
  maxMemoryUsageBytes: 268_435_456,
  maxBytesBeforeExternalGroupBy: 134_217_728,
  maxReadsPerSecond: 50,
  maxWritesPerSecond: 50,
  maxUsageFallbackReadsPerSecond: 50,
};

export { DAY_MS, HOUR_MS } from './lib/metering.constants';

export function integrationClickHouseRateLimiters(): ClickHouseRateLimiters {
  return {
    read: new RateLimiterMemory({ points: 1_000_000, duration: 1 }),
    write: new RateLimiterMemory({ points: 1_000_000, duration: 1 }),
    usageFallback: new RateLimiterMemory({ points: 1_000_000, duration: 1 }),
  };
}

export function integrationClickHouseClient(): ClickHouseClient {
  return new ClickHouseClient(
    INTEGRATION_CLICKHOUSE_CONFIG,
    new StatsD({ mock: true }),
    integrationClickHouseRateLimiters()
  );
}

export async function truncateMeteringTables(
  client: ClickHouseClient
): Promise<void> {
  for (const table of [
    EVENTS_TABLE,
    NOTIFICATIONS_TABLE,
    SESSIONS_TABLE,
    WATERMARKS_TABLE,
  ]) {
    await client.command(`TRUNCATE TABLE IF EXISTS ${table}`);
  }
}

export async function optimizeFinal(
  client: ClickHouseClient,
  table: string
): Promise<void> {
  await client.command(`OPTIMIZE TABLE ${table} FINAL`);
}

/**
 * Integration specs anchor their event times one hour in the past so inserted
 * rows always fall inside acceptance and query windows regardless of when the
 * suite runs.
 */
export function anchoredClock(): {
  anchor: Date;
  at: (offsetMs: number) => Date;
} {
  const anchor = new Date(Date.now() - 60 * 60 * 1000);
  return {
    anchor,
    at: (offsetMs: number) => new Date(anchor.getTime() + offsetMs),
  };
}
