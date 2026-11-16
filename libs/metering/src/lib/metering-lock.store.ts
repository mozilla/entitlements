/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import {
  LocksStorage,
  type LockAcquireResult,
  type LockStore,
} from '@nestjs/locks';

import { MeteringLockRedisClient } from './metering-lock.provider';
import type { LockStoreRedis } from './metering.types';

const ACQUIRE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
local token = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return token`;

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

const lockKey = (key: string) => `lock:${key}`;
const fenceKey = (key: string) => `fence:${key}`;

@Injectable()
export class MeteringLockStore implements LockStore, OnApplicationShutdown {
  constructor(
    @Inject(MeteringLockRedisClient) private readonly redis: LockStoreRedis,
    storage: LocksStorage
  ) {
    storage.registerSource(this);
  }

  async acquire(
    key: string,
    owner: string,
    ttl: number
  ): Promise<LockAcquireResult> {
    const token = Number(
      await this.redis.eval(
        ACQUIRE_SCRIPT,
        2,
        lockKey(key),
        fenceKey(key),
        owner,
        ttl
      )
    );
    return token > 0
      ? { acquired: true, fencingToken: token }
      : { acquired: false };
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    const renewed = await this.redis.eval(
      RENEW_SCRIPT,
      1,
      lockKey(key),
      owner,
      ttl
    );
    return Number(renewed) === 1;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const released = await this.redis.eval(
      RELEASE_SCRIPT,
      1,
      lockKey(key),
      owner
    );
    return Number(released) === 1;
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
