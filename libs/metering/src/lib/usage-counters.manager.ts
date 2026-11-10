/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { z } from 'zod';

import type { MeteringWindow } from '@entitlements/shared/cms';

import { MeteringRedisClient } from './metering-redis.provider';
import { MeteringRedisConfig } from './metering-redis.config';
import { SESSION_EXPIRY_GRACE_MS } from './metering.constants';
import { UsageCountersError } from './metering.error';
import type {
  CounterExpiry,
  CounterIncrement,
  CounterWrites,
  DedupeStatus,
  MeterKey,
  MeterSubjectKey,
  MeteringRedis,
  MeteringRedisPipeline,
  WindowUsage,
} from './metering.types';
import { execRedisPipeline } from './utils/execRedisPipeline';
import { parseRedisRunId } from './utils/parseRedisRunId';
import {
  DEDUPE_CLAIMED_VALUE,
  DEDUPE_STORED_VALUE,
  INGEST_PAUSED_KEY,
  REDIS_CHECKED_AT_KEY,
  REDIS_FULLY_POPULATED_KEY,
  REDIS_RUN_ID_KEY,
  meterWindowKey,
  sessionKey,
} from './utils/redisKeys';
import { isSessionOpen, resolveWindow } from './utils/resolveWindow';
import { toError } from './utils/toError';
import { counterReadsForBuckets, splitIntoBuckets } from './utils/usageBuckets';

const nullableStringsSchema = z.array(z.string().nullable());

const APPLY_SESSION_EVENTS_SCRIPT = `#!lua
for index, key in ipairs(KEYS) do
  local offset = (index - 1) * 3
  local eventTime = tonumber(ARGV[offset + 1])
  local amount = tonumber(ARGV[offset + 2])
  local duration = tonumber(ARGV[offset + 3])
  local start = tonumber(redis.call('HGET', key, 'start'))
  if start == nil or eventTime >= start + duration then
    redis.call('HSET', key, 'start', ARGV[offset + 1], 'usage', ARGV[offset + 2])
    redis.call('PEXPIREAT', key, eventTime + duration + ${SESSION_EXPIRY_GRACE_MS})
  elseif eventTime >= start then
    redis.call('HINCRBY', key, 'usage', amount)
  end
end
return #KEYS
`;

export interface PopulationState {
  fullyPopulated: boolean;
  runId: string | null;
  checkedAt: Date | null;
}

export interface SessionState extends MeterSubjectKey {
  sessionStart: Date;
  usage: number;
  expireAtSeconds: number;
}

export interface DedupeKeyState {
  key: string;
  ttlSeconds: number;
}

@Injectable()
export class UsageCountersManager implements OnApplicationShutdown {
  constructor(
    private readonly meteringRedisConfig: MeteringRedisConfig,
    @Inject(MeteringRedisClient) private readonly redis: MeteringRedis
  ) {}

  async findWindowUsage(
    key: MeterSubjectKey,
    window: MeteringWindow,
    now: Date
  ): Promise<WindowUsage | undefined> {
    const pipeline = this.redis.pipeline();
    pipeline.get(REDIS_FULLY_POPULATED_KEY);

    if (window.kind === 'session') {
      pipeline.hmget(sessionKey(key), 'start', 'usage');
      const [fullyPopulated, session] = await this.exec(
        pipeline,
        'findWindowUsage'
      );
      if (fullyPopulated === null) {
        return undefined;
      }
      const [start, usage] = nullableStringsSchema.parse(session);
      const sessionStart = start === null ? undefined : new Date(Number(start));
      return {
        ...resolveWindow(window, now, sessionStart),
        usage: isSessionOpen(sessionStart, window.durationMs, now)
          ? Number(usage ?? 0)
          : 0,
      };
    }

    const bounds = resolveWindow(window, now);
    const reads = counterReadsForBuckets(
      key,
      splitIntoBuckets(bounds.windowStart, bounds.windowEnd)
    );
    for (const read of reads) {
      pipeline.hmget(read.key, ...read.fields);
    }
    const [fullyPopulated, ...counts] = await this.exec(
      pipeline,
      'findWindowUsage'
    );
    if (fullyPopulated === null) {
      return undefined;
    }
    const usage = counts
      .flatMap((reply) => nullableStringsSchema.parse(reply))
      .reduce((total, count) => total + Number(count ?? 0), 0);
    return { ...bounds, usage };
  }

  async findSessionStarts(
    meterKey: MeterKey,
    subjects: string[]
  ): Promise<Map<string, Date>> {
    if (subjects.length === 0) {
      return new Map();
    }
    const pipeline = this.redis.pipeline();
    for (const subject of subjects) {
      pipeline.hmget(sessionKey({ ...meterKey, subject }), 'start');
    }
    const replies = await this.exec(pipeline, 'findSessionStarts');
    const starts = new Map<string, Date>();
    subjects.forEach((subject, index) => {
      const [start] = nullableStringsSchema.parse(replies[index]);
      if (start !== null) {
        starts.set(subject, new Date(Number(start)));
      }
    });
    return starts;
  }

  async isIngestAllowed(): Promise<boolean> {
    const pipeline = this.redis.pipeline();
    pipeline.get(REDIS_FULLY_POPULATED_KEY);
    pipeline.get(INGEST_PAUSED_KEY);
    pipeline.get(REDIS_RUN_ID_KEY);
    const [[fullyPopulated, ingestPaused, recordedRunId], runId] =
      await Promise.all([
        this.exec(pipeline, 'isIngestAllowed'),
        this.readRunId('isIngestAllowed'),
      ]);
    return (
      fullyPopulated !== null &&
      ingestPaused === null &&
      recordedRunId === runId
    );
  }

  async claim(keys: string[]): Promise<DedupeStatus[]> {
    if (keys.length === 0) {
      return [];
    }

    const claims = this.redis.pipeline();
    for (const key of keys) {
      claims.set(
        key,
        DEDUPE_CLAIMED_VALUE,
        'EX',
        this.meteringRedisConfig.claimTtlSeconds,
        'NX'
      );
      claims.get(key);
    }
    const replies = await this.exec(claims, 'claim');

    return keys.map((_, index) => {
      if (replies[index * 2] === 'OK') {
        return 'claimed';
      }
      return replies[index * 2 + 1] === DEDUPE_STORED_VALUE
        ? 'duplicate'
        : 'pending';
    });
  }

  async confirm(keys: string[], counterWrites: CounterWrites): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const transaction = this.redis.multi();
    for (const key of keys) {
      transaction.set(
        key,
        DEDUPE_STORED_VALUE,
        'EX',
        this.meteringRedisConfig.dedupeTtlSeconds
      );
    }
    for (const { key, field, amount } of counterWrites.increments) {
      transaction.hincrby(key, field, amount);
    }
    for (const { key, expireAtSeconds } of counterWrites.expiries) {
      transaction.expireat(key, expireAtSeconds);
    }
    const { sessionEvents } = counterWrites;
    if (sessionEvents.length > 0) {
      transaction.eval(
        APPLY_SESSION_EVENTS_SCRIPT,
        sessionEvents.length,
        ...sessionEvents.map((event) => event.key),
        ...sessionEvents.flatMap((event) => [
          event.eventTimeMs,
          event.amount,
          event.durationMs,
        ])
      );
    }
    await this.exec(transaction, 'confirm');
  }

  async release(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    try {
      await this.redis.del(...keys);
    } catch (err) {
      throw new UsageCountersError('release', toError(err));
    }
  }

  async findRedisRunId(): Promise<string> {
    const runId = await this.readRunId('findRedisRunId');
    if (runId === null) {
      throw new UsageCountersError(
        'findRedisRunId',
        new Error('INFO server did not include run_id')
      );
    }
    return runId;
  }

  async findPopulationState(): Promise<PopulationState> {
    const pipeline = this.redis.pipeline();
    pipeline.get(REDIS_FULLY_POPULATED_KEY);
    pipeline.get(REDIS_RUN_ID_KEY);
    pipeline.get(REDIS_CHECKED_AT_KEY);
    const [fullyPopulated, runId, checkedAt] = nullableStringsSchema.parse(
      await this.exec(pipeline, 'findPopulationState')
    );
    return {
      fullyPopulated: fullyPopulated !== null,
      runId,
      checkedAt: checkedAt === null ? null : new Date(checkedAt),
    };
  }

  async findMeterWindowFingerprints(
    slugs: string[]
  ): Promise<Map<string, string | null>> {
    if (slugs.length === 0) {
      return new Map();
    }
    const pipeline = this.redis.pipeline();
    for (const slug of slugs) {
      pipeline.get(meterWindowKey(slug));
    }
    const fingerprints = nullableStringsSchema.parse(
      await this.exec(pipeline, 'findMeterWindowFingerprints')
    );
    return new Map(slugs.map((slug, index) => [slug, fingerprints[index]]));
  }

  async recordMeterWindowFingerprints(
    fingerprints: Map<string, string>
  ): Promise<void> {
    if (fingerprints.size === 0) {
      return;
    }
    const pipeline = this.redis.pipeline();
    for (const [slug, fingerprint] of fingerprints) {
      pipeline.set(meterWindowKey(slug), fingerprint);
    }
    await this.exec(pipeline, 'recordMeterWindowFingerprints');
  }

  async pauseIngest(ttlSeconds: number, now: Date): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.set(INGEST_PAUSED_KEY, now.toISOString(), 'EX', ttlSeconds);
    await this.exec(pipeline, 'pauseIngest');
  }

  async resumeIngest(): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(INGEST_PAUSED_KEY);
    await this.exec(pipeline, 'resumeIngest');
  }

  async markFullyPopulated(runId: string, now: Date): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.set(REDIS_FULLY_POPULATED_KEY, now.toISOString());
    pipeline.set(REDIS_RUN_ID_KEY, runId);
    pipeline.set(REDIS_CHECKED_AT_KEY, now.toISOString());
    await this.exec(pipeline, 'markFullyPopulated');
  }

  async markChecked(runId: string, now: Date): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.set(REDIS_RUN_ID_KEY, runId);
    pipeline.set(REDIS_CHECKED_AT_KEY, now.toISOString());
    await this.exec(pipeline, 'markChecked');
  }

  async writeCounterTotals(
    totals: CounterIncrement[],
    expiries: CounterExpiry[]
  ): Promise<void> {
    if (totals.length === 0) {
      return;
    }
    const pipeline = this.redis.pipeline();
    for (const { key, field, amount } of totals) {
      pipeline.hset(key, field, amount);
    }
    for (const { key, expireAtSeconds } of expiries) {
      pipeline.expireat(key, expireAtSeconds);
    }
    await this.exec(pipeline, 'writeCounterTotals');
  }

  async writeSessions(sessions: SessionState[]): Promise<void> {
    if (sessions.length === 0) {
      return;
    }
    const pipeline = this.redis.pipeline();
    for (const session of sessions) {
      const key = sessionKey(session);
      pipeline.hset(
        key,
        'start',
        session.sessionStart.getTime(),
        'usage',
        session.usage
      );
      pipeline.expireat(key, session.expireAtSeconds);
    }
    await this.exec(pipeline, 'writeSessions');
  }

  async writeDedupeKeys(keys: DedupeKeyState[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const pipeline = this.redis.pipeline();
    for (const { key, ttlSeconds } of keys) {
      pipeline.set(key, DEDUPE_STORED_VALUE, 'EX', ttlSeconds);
    }
    await this.exec(pipeline, 'writeDedupeKeys');
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  private async readRunId(operation: string): Promise<string | null> {
    try {
      return parseRedisRunId(await this.redis.info('server'));
    } catch (err) {
      throw new UsageCountersError(operation, toError(err));
    }
  }

  private exec(
    pipeline: MeteringRedisPipeline,
    operation: string
  ): Promise<unknown[]> {
    return execRedisPipeline(
      pipeline,
      (cause) => new UsageCountersError(operation, cause)
    );
  }
}
