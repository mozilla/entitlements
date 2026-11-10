/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  RedisAdapter,
  type RedisCacheStore,
} from './type-cachable-redis-adapter';

const CACHE_KEY = 'usage-grants:["subject-1"]';

describe('RedisAdapter', () => {
  let store: jest.Mocked<RedisCacheStore>;
  let adapter: RedisAdapter;

  beforeEach(() => {
    store = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    adapter = new RedisAdapter(store);
  });

  describe('get', () => {
    it('returns undefined when the key does not exist', async () => {
      await expect(adapter.get(CACHE_KEY)).resolves.toBeUndefined();
    });

    it('returns the stored value parsed from JSON', async () => {
      store.get.mockResolvedValueOnce('[{"slug":"chat","amount":5}]');

      await expect(adapter.get(CACHE_KEY)).resolves.toEqual([
        { slug: 'chat', amount: 5 },
      ]);
    });

    it('returns an empty list stored for a subject with no entries', async () => {
      store.get.mockResolvedValueOnce('[]');

      await expect(adapter.get(CACHE_KEY)).resolves.toEqual([]);
    });

    it('rejects when the store fails', async () => {
      store.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(adapter.get(CACHE_KEY)).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('set', () => {
    it('stores the value as JSON with the given TTL in seconds', async () => {
      await adapter.set(CACHE_KEY, [{ slug: 'chat', amount: 5 }], 3600);

      expect(store.set).toHaveBeenCalledWith(
        CACHE_KEY,
        '[{"slug":"chat","amount":5}]',
        'EX',
        3600
      );
    });

    it('uses a 300 second TTL when none is given', async () => {
      await adapter.set(CACHE_KEY, []);

      expect(store.set).toHaveBeenCalledWith(CACHE_KEY, '[]', 'EX', 300);
    });

    it('rejects when the store fails', async () => {
      store.set.mockRejectedValueOnce(new Error('OOM'));

      await expect(adapter.set(CACHE_KEY, [])).rejects.toThrow('OOM');
    });
  });

  describe('del', () => {
    it('deletes a single key', async () => {
      await adapter.del(CACHE_KEY);

      expect(store.del).toHaveBeenCalledWith(CACHE_KEY);
    });

    it('deletes several keys in one call', async () => {
      await adapter.del([CACHE_KEY, 'usage-grants:["subject-2"]']);

      expect(store.del).toHaveBeenCalledWith(
        CACHE_KEY,
        'usage-grants:["subject-2"]'
      );
    });

    it('does not call the store for an empty list', async () => {
      await expect(adapter.del([])).resolves.toBe(0);

      expect(store.del).not.toHaveBeenCalled();
    });
  });

  it('does not support listing keys', async () => {
    await expect(adapter.keys('*')).rejects.toThrow(
      'keys() not supported for cachable RedisAdapter'
    );
  });

  it('does not support deleting hashes', async () => {
    await expect(adapter.delHash('grants')).rejects.toThrow(
      'delHash() not supported for cachable RedisAdapter'
    );
  });

  it('reports a client TTL of 0', () => {
    expect(adapter.getClientTTL()).toBe(0);
  });
});
