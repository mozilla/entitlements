/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LocksStorage } from '@nestjs/locks';

import { MeteringLockStore } from './metering-lock.store';
import type { LockStoreRedis } from './metering.types';

const KEY = 'sweep:owner';
const OWNER = 'owner-a';
const TTL_MS = 30_000;

describe('MeteringLockStore', () => {
  let redis: jest.Mocked<LockStoreRedis>;
  let storage: LocksStorage;
  let store: MeteringLockStore;

  beforeEach(() => {
    redis = {
      eval: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
    storage = new LocksStorage();
    store = new MeteringLockStore(redis, storage);
  });

  it('registers itself as the lock store', () => {
    expect(storage.source).toBe(store);
  });

  describe('acquire', () => {
    it('takes the lock key and its fencing counter key', async () => {
      redis.eval.mockResolvedValue(1);

      await store.acquire(KEY, OWNER, TTL_MS);

      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("'INCR'"),
        2,
        `lock:${KEY}`,
        `fence:${KEY}`,
        OWNER,
        TTL_MS
      );
    });

    it('returns the fencing token when acquired', async () => {
      redis.eval.mockResolvedValue(42);

      await expect(store.acquire(KEY, OWNER, TTL_MS)).resolves.toEqual({
        acquired: true,
        fencingToken: 42,
      });
    });

    it('reports a held lock as not acquired', async () => {
      redis.eval.mockResolvedValue(0);

      await expect(store.acquire(KEY, OWNER, TTL_MS)).resolves.toEqual({
        acquired: false,
      });
    });

    it('propagates a Redis failure', async () => {
      const failure = new Error('ECONNREFUSED');
      redis.eval.mockRejectedValue(failure);

      await expect(store.acquire(KEY, OWNER, TTL_MS)).rejects.toBe(failure);
    });
  });

  describe('renew', () => {
    it('extends the lock only for its owner', async () => {
      redis.eval.mockResolvedValue(1);

      await store.renew(KEY, OWNER, TTL_MS);

      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("'PEXPIRE'"),
        1,
        `lock:${KEY}`,
        OWNER,
        TTL_MS
      );
    });

    it.each([
      { reply: 1, renewed: true },
      { reply: 0, renewed: false },
    ])('returns $renewed when Redis replies $reply', async ({ reply, renewed }) => {
      redis.eval.mockResolvedValue(reply);

      await expect(store.renew(KEY, OWNER, TTL_MS)).resolves.toBe(renewed);
    });
  });

  describe('release', () => {
    it('deletes the lock only for its owner', async () => {
      redis.eval.mockResolvedValue(1);

      await store.release(KEY, OWNER);

      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("'DEL'"),
        1,
        `lock:${KEY}`,
        OWNER
      );
    });

    it.each([
      { reply: 1, released: true },
      { reply: 0, released: false },
    ])('returns $released when Redis replies $reply', async ({ reply, released }) => {
      redis.eval.mockResolvedValue(reply);

      await expect(store.release(KEY, OWNER)).resolves.toBe(released);
    });
  });

  describe('shutdown', () => {
    it('quits the Redis connection', async () => {
      await store.onApplicationShutdown();

      expect(redis.quit).toHaveBeenCalledTimes(1);
    });

    it('disconnects when quitting fails', async () => {
      redis.quit.mockRejectedValue(new Error('ECONNRESET'));

      await store.onApplicationShutdown();

      expect(redis.disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
