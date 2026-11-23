/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Provider } from '@nestjs/common';
import Redis from 'ioredis';

import { MeteringRedisConfig } from './metering-redis.config';

export const MeteringRedisClient = Symbol('METERING_REDIS_CLIENT');

export function createMeteringRedis(
  config: MeteringRedisConfig,
  keyPrefix: string
): Redis.Redis {
  return new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    keyPrefix,
    connectTimeout: config.connectTimeoutMs,
    commandTimeout: config.commandTimeoutMs,
    ...(config.tls ? { tls: {} } : {}),
  });
}

export const MeteringRedisClientProvider: Provider<Redis.Redis> = {
  provide: MeteringRedisClient,
  useFactory: (config: MeteringRedisConfig) =>
    createMeteringRedis(config, config.keyPrefix),
  inject: [MeteringRedisConfig],
};
