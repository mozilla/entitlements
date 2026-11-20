/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LocksStorage } from '@nestjs/locks';
import { lockStoreContract } from '@nestjs/locks/testing';
import Redis from 'ioredis';

import { RedisLockStore } from './redis-lock.store';

const REDIS_HOST = process.env['REDIS_TEST_HOST'] ?? 'localhost';
const REDIS_PORT = Number(process.env['REDIS_TEST_PORT'] ?? 6379);
const KEY_PREFIX = 'test-shared:locks:';
const CONTRACT_TIMEOUT_MS = 60_000;

describe('RedisLockStore against a real Redis', () => {
  let prefixed: Redis.Redis;
  let raw: Redis.Redis;

  async function deleteTestKeys(): Promise<void> {
    const keys = await raw.keys(`${KEY_PREFIX}*`);
    if (keys.length > 0) {
      await raw.del(...keys);
    }
  }

  beforeAll(async () => {
    prefixed = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      keyPrefix: KEY_PREFIX,
    });
    raw = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    await deleteTestKeys();
  });

  afterAll(async () => {
    await deleteTestKeys();
    await prefixed.quit();
    await raw.quit();
  });

  const cases = lockStoreContract(
    () => new RedisLockStore(prefixed, new LocksStorage()),
    { concurrent: true }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'satisfies the LockStore contract: %s',
    async (_name, contractCase) => {
      await contractCase.run();
    },
    CONTRACT_TIMEOUT_MS
  );
});
