/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { OnApplicationShutdown, Provider } from '@nestjs/common';
import type { CacheClient } from '@type-cacheable/core';
import type Redis from 'ioredis';

import { StrapiRemoteCacheClient } from '@entitlements/shared/cms';
import { RedisAdapter } from '@entitlements/shared/db/type-cacheable';

import { MeteringRedisConfig } from './metering-redis.config';
import { createMeteringRedis } from './metering-redis.provider';

export class MeteringStrapiCacheClient
  extends RedisAdapter
  implements OnApplicationShutdown
{
  constructor(private readonly redisClient: Redis.Redis) {
    super(redisClient);
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redisClient.quit();
    } catch {
      this.redisClient.disconnect();
    }
  }
}

export const MeteringStrapiCacheClientProvider: Provider<CacheClient> = {
  provide: StrapiRemoteCacheClient,
  useFactory: (config: MeteringRedisConfig) =>
    new MeteringStrapiCacheClient(
      createMeteringRedis(config, `${config.keyPrefix}cms:`)
    ),
  inject: [MeteringRedisConfig],
};
