/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Injectable } from '@nestjs/common';

import type { MeteringWindow } from '@entitlements/shared/cms';

import { MeteringRedisConfig } from './metering-redis.config';
import { MeteringUsageCountersConfig } from './metering-usage-counters.config';
import { MAX_TIMESTAMP_FUTURE_MS } from './metering.constants';
import type { CounterIncrement, MeterKey } from './metering.types';
import {
  UsageCountersManager,
  type DedupeKeyState,
  type SessionState,
} from './usage-counters.manager';
import { UsageRefillRepository } from './usage-refill.repository';
import {
  dayCountersExpireAt,
  hourCountersExpireAt,
  sessionExpireAt,
} from './utils/counterExpiry';
import { dayCountersKey, dedupeKey, hourCountersKey } from './utils/redisKeys';
import { resolveWindow } from './utils/resolveWindow';
import {
  dayField,
  dayOf,
  hourField,
  monthOf,
  startOfUtcDay,
} from './utils/usageBuckets';

export interface RefillMeter extends MeterKey {
  window: MeteringWindow;
}

export interface RefillCounts {
  counters: number;
  sessions: number;
  dedupeKeys: number;
}

interface CounterTotal extends CounterIncrement {
  expireAtSeconds: number;
}

class WriteBatch<T> {
  private items: T[] = [];
  public written = 0;

  constructor(
    private readonly write: (items: T[]) => Promise<void>,
    private readonly batchSize: number
  ) {}

  async add(item: T): Promise<void> {
    this.items.push(item);
    if (this.items.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.items.length === 0) {
      return;
    }
    await this.write(this.items);
    this.written += this.items.length;
    this.items = [];
  }
}

@Injectable()
export class UsageRefillManager {
  constructor(
    private readonly usageRefillRepository: UsageRefillRepository,
    private readonly usageCountersManager: UsageCountersManager,
    private readonly meteringRedisConfig: MeteringRedisConfig,
    private readonly usageCountersConfig: MeteringUsageCountersConfig
  ) {}

  async refillMeter(
    meter: RefillMeter,
    touchedSince: Date | null,
    now: Date
  ): Promise<RefillCounts> {
    const { window } = meter;
    if (window.kind === 'session') {
      return {
        counters: 0,
        sessions: await this.refillSessions(
          meter,
          window.durationMs,
          touchedSince,
          now
        ),
        dedupeKeys: 0,
      };
    }

    const { windowStart } = resolveWindow(window, now);
    const range = {
      clientId: meter.clientId,
      slug: meter.slug,
      from: startOfUtcDay(windowStart),
      to: new Date(now.getTime() + MAX_TIMESTAMP_FUTURE_MS),
      touchedSince,
    };
    const batch = this.batch((totals: CounterTotal[]) =>
      this.writeCounterTotals(totals)
    );

    for await (const row of this.usageRefillRepository.streamDayTotals(range)) {
      const day = new Date(`${row.day}T00:00:00.000Z`);
      await batch.add({
        key: dayCountersKey({ ...meter, subject: row.subject }, monthOf(day)),
        field: dayField(day),
        amount: row.usage,
        expireAtSeconds: dayCountersExpireAt(day, window),
      });
    }

    if (window.kind === 'sliding') {
      for await (const row of this.usageRefillRepository.streamHourTotals(
        range
      )) {
        const hour = new Date(row.hour);
        await batch.add({
          key: hourCountersKey({ ...meter, subject: row.subject }, dayOf(hour)),
          field: hourField(hour),
          amount: row.usage,
          expireAtSeconds: hourCountersExpireAt(hour, window.durationMs),
        });
      }
    }

    await batch.flush();
    return { counters: batch.written, sessions: 0, dedupeKeys: 0 };
  }

  async refillDedupeKeys(ingestedSince: Date, now: Date): Promise<number> {
    const ttlSeconds = this.meteringRedisConfig.dedupeTtlSeconds;
    const batch = this.batch((keys: DedupeKeyState[]) =>
      this.usageCountersManager.writeDedupeKeys(keys)
    );

    for await (const row of this.usageRefillRepository.streamIngestedEvents(
      ingestedSince
    )) {
      const ageSeconds = Math.floor(
        (now.getTime() - Date.parse(row.ingested_at_iso)) / 1000
      );
      const remainingSeconds = ttlSeconds - ageSeconds;
      if (remainingSeconds <= 0) {
        continue;
      }
      await batch.add({
        key: dedupeKey(row.client_id, row.event_id_hash),
        ttlSeconds: remainingSeconds,
      });
    }
    await batch.flush();
    return batch.written;
  }

  private async refillSessions(
    meter: MeterKey,
    durationMs: number,
    touchedSince: Date | null,
    now: Date
  ): Promise<number> {
    const batch = this.batch((sessions: SessionState[]) =>
      this.usageCountersManager.writeSessions(sessions)
    );

    for await (const row of this.usageRefillRepository.streamOpenSessions({
      clientId: meter.clientId,
      slug: meter.slug,
      expiredBefore: new Date(now.getTime() - durationMs),
      to: new Date(now.getTime() + MAX_TIMESTAMP_FUTURE_MS),
      touchedSince,
    })) {
      const sessionStart = new Date(row.started_at_iso);
      await batch.add({
        clientId: meter.clientId,
        slug: meter.slug,
        subject: row.subject,
        sessionStart,
        usage: row.usage,
        expireAtSeconds: sessionExpireAt(sessionStart, durationMs),
      });
    }
    await batch.flush();
    return batch.written;
  }

  private batch<T>(write: (items: T[]) => Promise<void>): WriteBatch<T> {
    return new WriteBatch(write, this.usageCountersConfig.refillBatchSize);
  }

  private writeCounterTotals(totals: CounterTotal[]): Promise<void> {
    const expiries = new Map(
      totals.map(({ key, expireAtSeconds }) => [key, { key, expireAtSeconds }])
    );
    return this.usageCountersManager.writeCounterTotals(
      totals.map(({ key, field, amount }) => ({ key, field, amount })),
      Array.from(expiries.values())
    );
  }
}
