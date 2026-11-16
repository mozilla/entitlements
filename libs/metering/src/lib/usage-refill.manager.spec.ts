/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Test } from '@nestjs/testing';

import type { MeteringWindow } from '@entitlements/shared/cms';

import {
  MeteringRedisConfig,
  MockMeteringRedisConfig,
} from './metering-redis.config';
import {
  MeteringUsageCountersConfig,
  MockMeteringUsageCountersConfig,
} from './metering-usage-counters.config';
import { UsageCountersError } from './metering.error';
import { UsageCountersManager } from './usage-counters.manager';
import { UsageRefillManager } from './usage-refill.manager';
import { UsageRefillRepository } from './usage-refill.repository';
import {
  dayCountersExpireAt,
  hourCountersExpireAt,
} from './utils/counterExpiry';

const NOW = new Date('2026-11-05T13:37:00.000Z');
const MONTHLY: MeteringWindow = { kind: 'calendar', period: 'monthly' };
const SLIDING_DURATION_MS = 2 * 60 * 60 * 1000;
const SLIDING: MeteringWindow = {
  kind: 'sliding',
  durationMs: SLIDING_DURATION_MS,
};
const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;
const SESSION: MeteringWindow = {
  kind: 'session',
  durationMs: SESSION_DURATION_MS,
};

async function* rows<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

describe('UsageRefillManager', () => {
  let manager: UsageRefillManager;
  let repository: jest.Mocked<
    Pick<
      UsageRefillRepository,
      | 'streamDayTotals'
      | 'streamHourTotals'
      | 'streamOpenSessions'
      | 'streamIngestedEvents'
    >
  >;
  let countersManager: jest.Mocked<
    Pick<
      UsageCountersManager,
      'writeCounterTotals' | 'writeSessions' | 'writeDedupeKeys'
    >
  >;

  beforeEach(async () => {
    repository = {
      streamDayTotals: jest.fn().mockImplementation(() => rows([])),
      streamHourTotals: jest.fn().mockImplementation(() => rows([])),
      streamOpenSessions: jest.fn().mockImplementation(() => rows([])),
      streamIngestedEvents: jest.fn().mockImplementation(() => rows([])),
    };
    countersManager = {
      writeCounterTotals: jest.fn().mockResolvedValue(undefined),
      writeSessions: jest.fn().mockResolvedValue(undefined),
      writeDedupeKeys: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsageRefillManager,
        { provide: UsageRefillRepository, useValue: repository },
        { provide: UsageCountersManager, useValue: countersManager },
        { provide: MeteringRedisConfig, useValue: MockMeteringRedisConfig },
        {
          provide: MeteringUsageCountersConfig,
          useValue: MockMeteringUsageCountersConfig,
        },
      ],
    }).compile();

    manager = moduleRef.get(UsageRefillManager);
  });

  describe('refillMeter for a calendar meter', () => {
    const meter = { clientId: 'vpn', slug: 'chat', window: MONTHLY };

    it('reads day totals from the window start to just past now', async () => {
      await manager.refillMeter(meter, null, NOW);

      expect(repository.streamDayTotals).toHaveBeenCalledWith({
        clientId: 'vpn',
        slug: 'chat',
        from: new Date('2026-11-01T00:00:00.000Z'),
        to: new Date('2026-11-05T13:42:00.000Z'),
        touchedSince: null,
      });
      expect(repository.streamHourTotals).not.toHaveBeenCalled();
    });

    it('sets each day total on its month hash', async () => {
      repository.streamDayTotals.mockReturnValue(
        rows([{ subject: 'user-1', day: '2026-11-05', usage: 12 }])
      );

      await expect(manager.refillMeter(meter, null, NOW)).resolves.toEqual({
        counters: 1,
        sessions: 0,
        dedupeKeys: 0,
      });
      expect(countersManager.writeCounterTotals).toHaveBeenCalledWith(
        [
          {
            key: 'usage-days:["vpn","chat","user-1","2026-11"]',
            field: 'd5',
            amount: 12,
          },
        ],
        [
          {
            key: 'usage-days:["vpn","chat","user-1","2026-11"]',
            expireAtSeconds: dayCountersExpireAt(
              new Date('2026-11-05T00:00:00.000Z'),
              MONTHLY
            ),
          },
        ]
      );
    });

    it('writes in batches of the configured size', async () => {
      repository.streamDayTotals.mockReturnValue(
        rows([
          { subject: 'user-1', day: '2026-11-01', usage: 1 },
          { subject: 'user-1', day: '2026-11-02', usage: 2 },
          { subject: 'user-1', day: '2026-11-03', usage: 3 },
        ])
      );

      await manager.refillMeter(meter, null, NOW);

      expect(
        countersManager.writeCounterTotals.mock.calls.map(
          ([totals]) => totals.length
        )
      ).toEqual([2, 1]);
    });

    it('passes the repair point through to the repository', async () => {
      const since = new Date('2026-11-05T13:20:00.000Z');

      await manager.refillMeter(meter, since, NOW);

      expect(repository.streamDayTotals).toHaveBeenCalledWith(
        expect.objectContaining({ touchedSince: since })
      );
    });

    it('propagates a write failure', async () => {
      repository.streamDayTotals.mockReturnValue(
        rows([{ subject: 'user-1', day: '2026-11-05', usage: 12 }])
      );
      countersManager.writeCounterTotals.mockRejectedValue(
        new UsageCountersError('writeCounterTotals', new Error('OOM'))
      );

      await expect(manager.refillMeter(meter, null, NOW)).rejects.toThrow(
        UsageCountersError
      );
    });
  });

  describe('refillMeter for a sliding meter', () => {
    const meter = { clientId: 'vpn', slug: 'chat', window: SLIDING };

    it('reads from the start of the day the window starts in', async () => {
      await manager.refillMeter(meter, null, NOW);

      expect(repository.streamHourTotals).toHaveBeenCalledWith(
        expect.objectContaining({
          from: new Date('2026-11-05T00:00:00.000Z'),
        })
      );
    });

    it('sets both day totals and hour totals', async () => {
      repository.streamDayTotals.mockReturnValue(
        rows([{ subject: 'user-1', day: '2026-11-05', usage: 12 }])
      );
      repository.streamHourTotals.mockReturnValue(
        rows([{ subject: 'user-1', hour: '2026-11-05T13:00:00Z', usage: 4 }])
      );

      const counts = await manager.refillMeter(meter, null, NOW);

      expect(counts.counters).toBe(2);
      const written = countersManager.writeCounterTotals.mock.calls.flatMap(
        ([totals]) => totals
      );
      expect(written).toContainEqual({
        key: 'usage-hours:["vpn","chat","user-1","2026-11-05"]',
        field: 'h13',
        amount: 4,
      });
      const expiries = countersManager.writeCounterTotals.mock.calls.flatMap(
        ([, keyExpiries]) => keyExpiries
      );
      expect(expiries).toContainEqual({
        key: 'usage-hours:["vpn","chat","user-1","2026-11-05"]',
        expireAtSeconds: hourCountersExpireAt(
          new Date('2026-11-05T13:00:00.000Z'),
          SLIDING_DURATION_MS
        ),
      });
    });
  });

  describe('refillMeter for a session meter', () => {
    const meter = {
      clientId: 'vpn',
      slug: 'chat',
      window: SESSION,
    };

    it('reads sessions that are still open at now', async () => {
      await manager.refillMeter(meter, null, NOW);

      expect(repository.streamOpenSessions).toHaveBeenCalledWith({
        clientId: 'vpn',
        slug: 'chat',
        expiredBefore: new Date(NOW.getTime() - SESSION_DURATION_MS),
        to: new Date('2026-11-05T13:42:00.000Z'),
        touchedSince: null,
      });
      expect(repository.streamDayTotals).not.toHaveBeenCalled();
    });

    it('sets each open session with an expiry one hour after it ends', async () => {
      repository.streamOpenSessions.mockReturnValue(
        rows([
          {
            subject: 'user-1',
            started_at_iso: '2026-11-05T12:00:00.000Z',
            usage: 9,
          },
        ])
      );

      await expect(manager.refillMeter(meter, null, NOW)).resolves.toEqual({
        counters: 0,
        sessions: 1,
        dedupeKeys: 0,
      });
      expect(countersManager.writeSessions).toHaveBeenCalledWith([
        {
          clientId: 'vpn',
          slug: 'chat',
          subject: 'user-1',
          sessionStart: new Date('2026-11-05T12:00:00.000Z'),
          usage: 9,
          expireAtSeconds: Date.parse('2026-11-05T18:00:00.000Z') / 1000,
        },
      ]);
    });
  });

  describe('refillDedupeKeys', () => {
    it('stores each ingested event as a duplicate for the rest of its dedupe TTL', async () => {
      repository.streamIngestedEvents.mockReturnValue(
        rows([
          {
            client_id: 'vpn',
            event_id_hash: '1234',
            ingested_at_iso: '2026-11-05T13:36:00.000Z',
          },
        ])
      );

      await expect(
        manager.refillDedupeKeys(new Date('2026-11-04T12:37:00.000Z'), NOW)
      ).resolves.toBe(1);
      expect(countersManager.writeDedupeKeys).toHaveBeenCalledWith([
        {
          key: 'dedupe:["vpn","1234"]',
          ttlSeconds: MockMeteringRedisConfig.dedupeTtlSeconds - 60,
        },
      ]);
    });

    it('skips events whose dedupe TTL has already run out', async () => {
      repository.streamIngestedEvents.mockReturnValue(
        rows([
          {
            client_id: 'vpn',
            event_id_hash: '1234',
            ingested_at_iso: new Date(
              NOW.getTime() - MockMeteringRedisConfig.dedupeTtlSeconds * 1000
            ).toISOString(),
          },
        ])
      );

      await expect(
        manager.refillDedupeKeys(new Date('2026-11-04T12:37:00.000Z'), NOW)
      ).resolves.toBe(0);
    });
  });
});
