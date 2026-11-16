/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Provider } from '@nestjs/common';
import Redis from 'ioredis';

import { METERING_LOCKS_KEY_PREFIX } from './metering.constants';
import { MeteringRedisConfig } from './metering-redis.config';

export const MeteringLockRedisClient = Symbol('METERING_LOCK_REDIS_CLIENT');

export const MeteringLockRedisClientProvider: Provider<Redis.Redis> = {
  provide: MeteringLockRedisClient,
  useFactory: (config: MeteringRedisConfig) => {
    return new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      keyPrefix: METERING_LOCKS_KEY_PREFIX,
      connectTimeout: config.connectTimeoutMs,
      commandTimeout: config.commandTimeoutMs,
      ...(config.tls ? { tls: {} } : {}),
    });
  },
  inject: [MeteringRedisConfig],
};
