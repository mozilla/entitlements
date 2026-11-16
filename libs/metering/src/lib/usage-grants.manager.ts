/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable, Logger, type LoggerService } from '@nestjs/common';
import {
  Timestamp,
  type CollectionReference,
  type Firestore,
} from '@google-cloud/firestore';
import { Cacheable } from '@type-cacheable/core';
import { z } from 'zod';

import {
  CacheFirstStrategy,
  RedisAdapter,
} from '@entitlements/shared/db/type-cacheable';
import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import { MeteringConfig } from './metering.config';
import { MeteringFirestore } from './metering-firestore.provider';
import { MeteringRedisClient } from './metering-redis.provider';
import { UsageGrantsLoadError } from './metering.error';
import type { MeteringRedis } from './metering.types';
import {
  deleteUsageGrant,
  getUsageGrants,
  insertUsageGrant,
  type NewUsageGrant,
  type UsageGrantRecord,
} from './usage-grants.repository';
import { isUsageGrantActive } from './utils/isUsageGrantActive';
import { usageGrantsCacheKey } from './utils/redisKeys';
import { toError } from './utils/toError';
import { toExpiresAtMs } from './utils/toExpiresAtMs';

export interface CreateUsageGrantData {
  subject: string;
  slug: string;
  amount: number;
  grantedBy: string;
  reason?: string;
  expiresAt: Date | null;
}

const cachedUsageGrantsSchema = z.array(
  z.object({
    slug: z.string(),
    amount: z.number(),
    expiresAtMs: z.number().nullable(),
  })
);

type CachedUsageGrant = z.infer<typeof cachedUsageGrantsSchema>[number];

function toCachedUsageGrant(grant: UsageGrantRecord): CachedUsageGrant {
  return {
    slug: grant.slug,
    amount: grant.amount,
    expiresAtMs: toExpiresAtMs(grant.expiresAt),
  };
}

@Injectable()
export class UsageGrantsManager {
  private readonly grantsCache: RedisAdapter;
  private readonly grantsCacheStrategy: CacheFirstStrategy;

  constructor(
    private readonly meteringConfig: MeteringConfig,
    @Inject(MeteringFirestore) private readonly firestore: Firestore,
    @Inject(MeteringRedisClient) redis: MeteringRedis,
    @Inject(StatsDService) private readonly statsd: StatsD,
    @Inject(Logger) private readonly logger: LoggerService
  ) {
    this.grantsCache = new RedisAdapter(redis);
    this.grantsCacheStrategy = new CacheFirstStrategy(
      () => this.statsd.increment('metering.usage_grants.cache_write_error'),
      undefined,
      this.logger
    );
  }

  get collectionRef(): CollectionReference {
    return this.firestore.collection(
      this.meteringConfig.usageGrants.firestoreCollectionName
    );
  }

  async createGrant(data: CreateUsageGrantData): Promise<UsageGrantRecord> {
    const record: NewUsageGrant = {
      subject: data.subject,
      slug: data.slug,
      amount: data.amount,
      grantedBy: data.grantedBy,
      reason: data.reason,
      createdAt: Timestamp.now(),
      expiresAt: data.expiresAt ? Timestamp.fromDate(data.expiresAt) : null,
    };
    const created = await insertUsageGrant(this.collectionRef, record);
    await this.clearCachedGrants(created.subject);
    return created;
  }

  async listGrants(
    subject: string,
    slug?: string
  ): Promise<UsageGrantRecord[]> {
    const grants = await getUsageGrants(this.collectionRef, subject);
    return slug === undefined
      ? grants
      : grants.filter((grant) => grant.slug === slug);
  }

  async deleteGrant(id: string): Promise<void> {
    const deleted = await deleteUsageGrant(this.collectionRef, id);
    await this.clearCachedGrants(deleted.subject);
  }

  async getActiveGrantedAmount(
    subject: string,
    slug: string,
    date: Date
  ): Promise<number> {
    const grants = await this.findSubjectGrants(subject);
    return grants
      .filter(
        (grant) =>
          grant.slug === slug && isUsageGrantActive(grant.expiresAtMs, date)
      )
      .reduce((total, grant) => total + grant.amount, 0);
  }

  @Cacheable({
    cacheKey: (args: string[]) => usageGrantsCacheKey(args[0]),
    client: (_: unknown, context: UsageGrantsManager) => context.grantsCache,
    strategy: (_: unknown, context: UsageGrantsManager) =>
      context.grantsCacheStrategy,
    ttlSeconds: (_: unknown, context: UsageGrantsManager) =>
      context.meteringConfig.usageGrants.cacheTtlSeconds,
  })
  async findCachedSubjectGrants(subject: string): Promise<CachedUsageGrant[]> {
    try {
      return await this.loadSubjectGrants(subject);
    } catch (err) {
      throw new UsageGrantsLoadError(toError(err));
    }
  }

  private async findSubjectGrants(
    subject: string
  ): Promise<CachedUsageGrant[]> {
    try {
      return cachedUsageGrantsSchema.parse(
        await this.findCachedSubjectGrants(subject)
      );
    } catch (err) {
      if (err instanceof UsageGrantsLoadError) {
        throw err;
      }
      this.statsd.increment('metering.usage_grants.cache_read_error');
      this.logger.error(err);
      return this.loadSubjectGrants(subject);
    }
  }

  private async loadSubjectGrants(
    subject: string
  ): Promise<CachedUsageGrant[]> {
    const grants = await getUsageGrants(this.collectionRef, subject);
    return grants.map(toCachedUsageGrant);
  }

  private async clearCachedGrants(subject: string): Promise<void> {
    try {
      await this.grantsCache.del(usageGrantsCacheKey(subject));
    } catch (err) {
      this.statsd.increment('metering.usage_grants.cache_clear_error');
      this.logger.error(err);
    }
  }
}
