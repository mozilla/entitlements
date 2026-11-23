/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const RedisLockStoreClient = Symbol('REDIS_LOCK_STORE_CLIENT');

export interface RedisLockStoreRedis {
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  quit(): Promise<'OK'>;
  disconnect(): void;
}
