/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'reflect-metadata';

import Redis from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { z } from 'zod';

import { StatsD } from '@entitlements/shared/metrics/statsd';

import { connectRateLimiterStore } from './clickhouse-rate-limiter.provider';
import { ClickHouseClient } from './clickhouse.client';
import { MockMeteringRedisConfig } from './metering-redis.config';
import { INTEGRATION_CLICKHOUSE_CONFIG } from '../testing';
import { ClickHouseRateLimitError } from './metering.error';

const REDIS_HOST = process.env['REDIS_TEST_HOST'] ?? 'localhost';
const REDIS_PORT = Number(process.env['REDIS_TEST_PORT'] ?? 6379);
const UNREACHABLE_REDIS_PORT = 1;
const KEY_PREFIX = 'test-metering:clickhouse:';
const REDIS_CONFIG = {
  ...MockMeteringRedisConfig,
  host: REDIS_HOST,
  port: REDIS_PORT,
};

const rowSchema = z.object({ one: z.number() });

describe('ClickHouse rate limiters against a real Redis', () => {
  let raw: Redis.Redis;
  let storeClients: Redis.Redis[];

  async function deleteTestKeys(): Promise<void> {
    const keys = await raw.keys(`${KEY_PREFIX}*`);
    if (keys.length > 0) {
      await raw.del(...keys);
    }
  }

  async function buildPod(): Promise<ClickHouseClient> {
    const storeClient = await connectRateLimiterStore(REDIS_CONFIG);
    storeClients.push(storeClient);
    return new ClickHouseClient(
      INTEGRATION_CLICKHOUSE_CONFIG,
      new StatsD({ mock: true }),
      {
        read: new RateLimiterRedis({
          storeClient,
          keyPrefix: `${KEY_PREFIX}read`,
          points: 2,
          duration: 60,
        }),
        write: new RateLimiterRedis({
          storeClient,
          keyPrefix: `${KEY_PREFIX}write`,
          points: 1,
          duration: 60,
        }),
        usageFallback: new RateLimiterRedis({
          storeClient,
          keyPrefix: `${KEY_PREFIX}usage-fallback`,
          points: 1,
          duration: 60,
        }),
      }
    );
  }

  beforeAll(() => {
    raw = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  });

  beforeEach(async () => {
    storeClients = [];
    await deleteTestKeys();
  });

  afterEach(async () => {
    for (const storeClient of storeClients) {
      await storeClient.quit();
    }
  });

  afterAll(async () => {
    await deleteTestKeys();
    await raw.quit();
  });

  it('runs a query as soon as the store connects', async () => {
    const pod = await buildPod();

    await expect(
      pod.query({ sql: 'SELECT 1 AS one', rowSchema })
    ).resolves.toEqual([{ one: 1 }]);
  });

  it('rejects the connection when Redis is unreachable', async () => {
    await expect(
      connectRateLimiterStore({
        ...REDIS_CONFIG,
        port: UNREACHABLE_REDIS_PORT,
      })
    ).rejects.toThrow(Error);
  });

  it('rejects a query once two pods together spend the read budget', async () => {
    const podA = await buildPod();
    const podB = await buildPod();
    await podA.query({ sql: 'SELECT 1 AS one', rowSchema });
    await podB.query({ sql: 'SELECT 1 AS one', rowSchema });

    await expect(
      podA.query({ sql: 'SELECT 1 AS one', rowSchema })
    ).rejects.toThrow(ClickHouseRateLimitError);
  });

  it('keeps the write budget separate from the read budget', async () => {
    const podA = await buildPod();
    const podB = await buildPod();
    await podA.query({ sql: 'SELECT 1 AS one', rowSchema });
    await podB.query({ sql: 'SELECT 1 AS one', rowSchema });

    await expect(podB.command('SELECT 1')).resolves.toBeUndefined();
  });
});
