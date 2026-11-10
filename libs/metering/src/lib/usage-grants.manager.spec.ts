/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Timestamp } from '@google-cloud/firestore';
import { Logger, type LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import { UsageGrantRecordFactory } from './metering.factories';
import {
  MockMeteringConfig,
  MockMeteringConfigProvider,
} from './metering.config';
import { MockMeteringFirestoreProvider } from './metering-firestore.provider';
import { MeteringRedisClient } from './metering-redis.provider';
import { UsageGrantsLoadError } from './metering.error';
import type { MeteringRedis } from './metering.types';
import { UsageGrantsManager } from './usage-grants.manager';
import {
  deleteUsageGrant,
  getUsageGrants,
  insertUsageGrant,
} from './usage-grants.repository';

jest.mock('./usage-grants.repository');

const CACHE_KEY = 'usage-grants:["user-1"]';

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('UsageGrantsManager', () => {
  let manager: UsageGrantsManager;
  let cache: Map<string, string>;
  let redis: jest.Mocked<Pick<MeteringRedis, 'get' | 'set' | 'del'>>;
  let statsd: jest.Mocked<Pick<StatsD, 'increment'>>;
  let logger: jest.Mocked<Pick<LoggerService, 'error' | 'warn'>>;
  const now = new Date('2026-05-15T12:00:00.000Z');

  beforeEach(async () => {
    jest.clearAllMocks();
    cache = new Map();
    redis = {
      get: jest.fn((key: string) => Promise.resolve(cache.get(key) ?? null)),
      set: jest.fn(
        (key: string, value: string, _mode: string, _seconds: number) => {
          cache.set(key, value);
          return Promise.resolve('OK');
        }
      ),
      del: jest.fn((...keys: string[]) => {
        keys.forEach((key) => cache.delete(key));
        return Promise.resolve(keys.length);
      }),
    };
    statsd = { increment: jest.fn() };
    logger = { error: jest.fn(), warn: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsageGrantsManager,
        MockMeteringConfigProvider,
        MockMeteringFirestoreProvider,
        { provide: MeteringRedisClient, useValue: redis },
        { provide: StatsDService, useValue: statsd },
        { provide: Logger, useValue: logger },
      ],
    }).compile();
    manager = moduleRef.get(UsageGrantsManager);
  });

  describe('createGrant', () => {
    beforeEach(() => {
      jest
        .mocked(insertUsageGrant)
        .mockImplementation((_db, record) =>
          Promise.resolve({ id: 'grant-1', ...record })
        );
    });

    it('stores an unending grant with a null expiry', async () => {
      await manager.createGrant({
        subject: 'user-1',
        slug: 'tokens',
        amount: 500,
        grantedBy: 'rp-1',
        expiresAt: null,
      });

      const [, record] = jest.mocked(insertUsageGrant).mock.calls[0];
      expect(record.expiresAt).toBeNull();
    });

    it('stores the expiry as a Timestamp derived from the provided date', async () => {
      const expiresAt = new Date('2026-06-01T00:00:00.000Z');

      await manager.createGrant({
        subject: 'user-1',
        slug: 'tokens',
        amount: 500,
        grantedBy: 'rp-1',
        expiresAt,
      });

      const [, record] = jest.mocked(insertUsageGrant).mock.calls[0];
      expect(record.expiresAt).toEqual(Timestamp.fromDate(expiresAt));
    });

    it('clears the cached grants of the subject', async () => {
      cache.set(CACHE_KEY, '[]');

      await manager.createGrant({
        subject: 'user-1',
        slug: 'tokens',
        amount: 500,
        grantedBy: 'rp-1',
        expiresAt: null,
      });

      expect(cache.has(CACHE_KEY)).toBe(false);
    });

    it('still returns the grant when clearing the cache fails', async () => {
      redis.del.mockRejectedValueOnce(new Error('connection closed'));

      await expect(
        manager.createGrant({
          subject: 'user-1',
          slug: 'tokens',
          amount: 500,
          grantedBy: 'rp-1',
          expiresAt: null,
        })
      ).resolves.toEqual(expect.objectContaining({ id: 'grant-1' }));
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.usage_grants.cache_clear_error'
      );
    });

    it('propagates a repository failure', async () => {
      jest
        .mocked(insertUsageGrant)
        .mockRejectedValue(new Error('firestore down'));

      await expect(
        manager.createGrant({
          subject: 'user-1',
          slug: 'tokens',
          amount: 500,
          grantedBy: 'rp-1',
          expiresAt: null,
        })
      ).rejects.toThrow('firestore down');
    });
  });

  describe('listGrants', () => {
    it('queries by subject alone and returns all grants when no slug is given', async () => {
      const grants = [
        UsageGrantRecordFactory({ slug: 'tokens' }),
        UsageGrantRecordFactory({ slug: 'seats' }),
      ];
      jest.mocked(getUsageGrants).mockResolvedValue(grants);

      const result = await manager.listGrants('user-1');

      const call = jest.mocked(getUsageGrants).mock.calls[0];
      expect(call).toHaveLength(2);
      expect(call[1]).toBe('user-1');
      expect(result).toBe(grants);
    });

    it('filters the fetched grants by slug in memory', async () => {
      jest
        .mocked(getUsageGrants)
        .mockResolvedValue([
          UsageGrantRecordFactory({ id: 'a', slug: 'tokens' }),
          UsageGrantRecordFactory({ id: 'b', slug: 'seats' }),
        ]);

      const result = await manager.listGrants('user-1', 'tokens');

      expect(result.map((grant) => grant.id)).toEqual(['a']);
    });

    it('propagates a repository failure', async () => {
      jest
        .mocked(getUsageGrants)
        .mockRejectedValue(new Error('firestore down'));

      await expect(manager.listGrants('user-1')).rejects.toThrow(
        'firestore down'
      );
    });
  });

  describe('deleteGrant', () => {
    it('delegates to the repository with the grant id', async () => {
      jest
        .mocked(deleteUsageGrant)
        .mockResolvedValue(UsageGrantRecordFactory({ subject: 'user-1' }));

      await manager.deleteGrant('grant-1');

      const [, idArg] = jest.mocked(deleteUsageGrant).mock.calls[0];
      expect(idArg).toBe('grant-1');
    });

    it('clears the cached grants of the deleted grant subject', async () => {
      cache.set(CACHE_KEY, '[]');
      jest
        .mocked(deleteUsageGrant)
        .mockResolvedValue(UsageGrantRecordFactory({ subject: 'user-1' }));

      await manager.deleteGrant('grant-1');

      expect(cache.has(CACHE_KEY)).toBe(false);
    });

    it('propagates a repository failure', async () => {
      jest
        .mocked(deleteUsageGrant)
        .mockRejectedValue(new Error('firestore down'));

      await expect(manager.deleteGrant('grant-1')).rejects.toThrow(
        'firestore down'
      );
    });
  });

  describe('getActiveGrantedAmount', () => {
    it('sums only the active grants for the given slug at the given time', async () => {
      jest.mocked(getUsageGrants).mockResolvedValue([
        UsageGrantRecordFactory({
          slug: 'tokens',
          amount: 100,
          expiresAt: null,
        }),
        UsageGrantRecordFactory({
          slug: 'tokens',
          amount: 50,
          expiresAt: Timestamp.fromDate(new Date('2026-06-01T00:00:00.000Z')),
        }),
        UsageGrantRecordFactory({
          slug: 'tokens',
          amount: 25,
          expiresAt: Timestamp.fromDate(new Date('2026-05-01T00:00:00.000Z')),
        }),
        UsageGrantRecordFactory({
          slug: 'seats',
          amount: 999,
          expiresAt: null,
        }),
      ]);

      const total = await manager.getActiveGrantedAmount(
        'user-1',
        'tokens',
        now
      );

      expect(total).toBe(150);
    });

    it('returns zero when the subject has no grants', async () => {
      jest.mocked(getUsageGrants).mockResolvedValue([]);

      const total = await manager.getActiveGrantedAmount(
        'user-1',
        'tokens',
        now
      );

      expect(total).toBe(0);
    });

    it('caches the grants of the subject for the configured TTL', async () => {
      jest
        .mocked(getUsageGrants)
        .mockResolvedValue([
          UsageGrantRecordFactory({ slug: 'tokens', amount: 100 }),
        ]);

      await manager.getActiveGrantedAmount('user-1', 'tokens', now);
      await settle();

      expect(redis.set).toHaveBeenCalledWith(
        CACHE_KEY,
        '[{"slug":"tokens","amount":100,"expiresAtMs":null}]',
        'EX',
        MockMeteringConfig.usageGrants.cacheTtlSeconds
      );
    });

    it('caches an empty list for a subject with no grants', async () => {
      jest.mocked(getUsageGrants).mockResolvedValue([]);

      await manager.getActiveGrantedAmount('user-1', 'tokens', now);
      await settle();

      expect(cache.get(CACHE_KEY)).toBe('[]');
    });

    it('answers from the cache without reading Firestore', async () => {
      cache.set(
        CACHE_KEY,
        JSON.stringify([
          { slug: 'tokens', amount: 40, expiresAtMs: null },
          {
            slug: 'tokens',
            amount: 7,
            expiresAtMs: Date.parse('2026-05-01T00:00:00.000Z'),
          },
        ])
      );

      await expect(
        manager.getActiveGrantedAmount('user-1', 'tokens', now)
      ).resolves.toBe(40);
      expect(getUsageGrants).not.toHaveBeenCalled();
    });

    it('reads Firestore when the cache read fails', async () => {
      redis.get.mockRejectedValueOnce(new Error('connection closed'));
      jest
        .mocked(getUsageGrants)
        .mockResolvedValue([
          UsageGrantRecordFactory({ slug: 'tokens', amount: 100 }),
        ]);

      await expect(
        manager.getActiveGrantedAmount('user-1', 'tokens', now)
      ).resolves.toBe(100);
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.usage_grants.cache_read_error'
      );
    });

    it('reads Firestore when the cached value has an unexpected shape', async () => {
      cache.set(CACHE_KEY, '[{"slug":"tokens"}]');
      jest
        .mocked(getUsageGrants)
        .mockResolvedValue([
          UsageGrantRecordFactory({ slug: 'tokens', amount: 100 }),
        ]);

      await expect(
        manager.getActiveGrantedAmount('user-1', 'tokens', now)
      ).resolves.toBe(100);
    });

    it('still answers when writing the cache fails', async () => {
      redis.set.mockRejectedValueOnce(new Error('OOM'));
      jest
        .mocked(getUsageGrants)
        .mockResolvedValue([
          UsageGrantRecordFactory({ slug: 'tokens', amount: 100 }),
        ]);

      await expect(
        manager.getActiveGrantedAmount('user-1', 'tokens', now)
      ).resolves.toBe(100);
      await settle();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.usage_grants.cache_write_error'
      );
    });

    it('wraps a repository failure in UsageGrantsLoadError', async () => {
      jest
        .mocked(getUsageGrants)
        .mockRejectedValue(new Error('firestore down'));

      await expect(
        manager.getActiveGrantedAmount('user-1', 'tokens', now)
      ).rejects.toThrow(UsageGrantsLoadError);
    });

    it('reads Firestore only once when the repository fails', async () => {
      jest
        .mocked(getUsageGrants)
        .mockRejectedValue(new Error('firestore down'));

      await manager
        .getActiveGrantedAmount('user-1', 'tokens', now)
        .catch(() => undefined);

      expect(getUsageGrants).toHaveBeenCalledTimes(1);
    });

    it('does not count a repository failure as a cache read error', async () => {
      jest
        .mocked(getUsageGrants)
        .mockRejectedValue(new Error('firestore down'));

      await manager
        .getActiveGrantedAmount('user-1', 'tokens', now)
        .catch(() => undefined);

      expect(statsd.increment).not.toHaveBeenCalledWith(
        'metering.usage_grants.cache_read_error'
      );
    });
  });
});
