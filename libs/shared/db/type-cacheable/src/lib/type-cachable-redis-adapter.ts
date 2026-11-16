/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CacheClient } from '@type-cacheable/core';

const DEFAULT_TTL_SECONDS = 300;

export interface RedisCacheStore {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: string,
    time: number
  ): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

export class RedisAdapter implements CacheClient {
  constructor(private readonly redis: RedisCacheStore) {
    this.get = this.get.bind(this);
    this.del = this.del.bind(this);
    this.delHash = this.delHash.bind(this);
    this.getClientTTL = this.getClientTTL.bind(this);
    this.keys = this.keys.bind(this);
    this.set = this.set.bind(this);
  }

  public async get(cacheKey: string): Promise<unknown> {
    const cachedValue = await this.redis.get(cacheKey);
    return cachedValue === null ? undefined : JSON.parse(cachedValue);
  }

  public async set(
    cacheKey: string,
    value: unknown,
    ttl?: number
  ): Promise<void> {
    await this.redis.set(
      cacheKey,
      JSON.stringify(value),
      'EX',
      ttl || DEFAULT_TTL_SECONDS
    );
  }

  public getClientTTL(): number {
    return 0;
  }

  public async del(keyOrKeys: string | string[]): Promise<number> {
    const keysToDelete = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    if (keysToDelete.length === 0) {
      return 0;
    }
    return this.redis.del(...keysToDelete);
  }

  public async keys(_: string): Promise<string[]> {
    throw new Error('keys() not supported for cachable RedisAdapter');
  }

  public async delHash(_: string | string[]): Promise<number> {
    throw new Error('delHash() not supported for cachable RedisAdapter');
  }
}
