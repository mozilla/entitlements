/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';

import { ClickHouseConfig } from './clickhouse.config';
import { MeteringRedisConfig } from './metering-redis.config';
import { ClickHouseRateLimiters } from './metering.types';

export const ClickHouseRateLimitersToken = Symbol('CLICKHOUSE_RATE_LIMITERS');

export async function connectRateLimiterStore(
  redisConfig: MeteringRedisConfig
): Promise<Redis.Redis> {
  const storeClient = new Redis({
    host: redisConfig.host,
    port: redisConfig.port,
    password: redisConfig.password,
    connectTimeout: redisConfig.connectTimeoutMs,
    commandTimeout: redisConfig.commandTimeoutMs,
    enableOfflineQueue: false,
    lazyConnect: true,
    ...(redisConfig.tls ? { tls: {} } : {}),
  });
  try {
    await storeClient.connect();
  } catch (err) {
    storeClient.disconnect();
    throw err;
  }
  return storeClient;
}

export const ClickHouseRateLimitersProvider: Provider<ClickHouseRateLimiters> =
  {
    provide: ClickHouseRateLimitersToken,
    useFactory: async (
      redisConfig: MeteringRedisConfig,
      clickHouseConfig: ClickHouseConfig
    ) => {
      const storeClient = await connectRateLimiterStore(redisConfig);
      const sharedLimiter = (keyPrefix: string, points: number) =>
        new RateLimiterRedis({
          storeClient,
          keyPrefix,
          points,
          duration: 1,
        });
      return {
        read: sharedLimiter(
          'metering:clickhouse:read',
          clickHouseConfig.maxReadsPerSecond
        ),
        write: sharedLimiter(
          'metering:clickhouse:write',
          clickHouseConfig.maxWritesPerSecond
        ),
        usageFallback: sharedLimiter(
          'metering:clickhouse:usage-fallback',
          clickHouseConfig.maxUsageFallbackReadsPerSecond
        ),
      };
    },
    inject: [MeteringRedisConfig, ClickHouseConfig],
  };
