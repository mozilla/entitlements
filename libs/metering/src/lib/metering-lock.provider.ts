/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Provider } from '@nestjs/common';
import type Redis from 'ioredis';

import { RedisLockStoreClient } from '@entitlements/shared/locks';

import { MeteringRedisConfig } from './metering-redis.config';
import { createMeteringRedis } from './metering-redis.provider';

export const MeteringLockRedisClientProvider: Provider<Redis.Redis> = {
  provide: RedisLockStoreClient,
  useFactory: (config: MeteringRedisConfig) =>
    createMeteringRedis(config, `${config.keyPrefix}locks:`),
  inject: [MeteringRedisConfig],
};
