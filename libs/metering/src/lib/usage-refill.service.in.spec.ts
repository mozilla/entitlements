/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';

import {
  MeteringConfigurationManager,
  StrapiMeterFactory,
  type MeteringWindow,
} from '@entitlements/shared/cms';
import { StatsDService } from '@entitlements/shared/metrics/statsd';

import {
  integrationClickHouseClient,
  truncateMeteringTables,
} from '../testing';
import { ClickHouseClient } from './clickhouse.client';
import { MeteringEventsManager } from './metering-events.manager';
import { MeteringEventsRepository } from './metering-events.repository';
import {
  MeteringRedisConfig,
  MockMeteringRedisConfig,
} from './metering-redis.config';
import { MeteringRedisClient } from './metering-redis.provider';
import {
  MeteringSweepConfig,
  MockMeteringSweepConfig,
} from './metering-sweep.config';
import { MeteringSweepManager } from './metering-sweep.manager';
import { MeteringSweepRepository } from './metering-sweep.repository';
import {
  MeteringUsageCountersConfig,
  MockMeteringUsageCountersConfig,
} from './metering-usage-counters.config';
import { UsageCountersManager } from './usage-counters.manager';
import { UsageRefillManager } from './usage-refill.manager';
import { UsageRefillRepository } from './usage-refill.repository';
import { UsageRefillService } from './usage-refill.service';
import { hashEventId } from './utils/hashEventId';
import { resolveWindow } from './utils/resolveWindow';

const REDIS_HOST = process.env['REDIS_TEST_HOST'] ?? 'localhost';
const REDIS_PORT = Number(process.env['REDIS_TEST_PORT'] ?? 6379);
const KEY_PREFIX = 'test-metering:refill-in-spec:';

const CLIENT_ID = 'vpn';
const MINUTE_MS = 60 * 1000;
const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;

const WINDOWS: Record<string, MeteringWindow> = {
  monthly: { kind: 'calendar', period: 'monthly' },
  sliding: { kind: 'sliding', durationMs: 3 * 60 * 60 * 1000 },
  session: { kind: 'session', durationMs: SESSION_DURATION_MS },
};

const describeIntegration =
  process.env['CI'] && !process.env['CLICKHOUSE_INTEGRATION_TESTS']
    ? describe.skip
    : describe;

describeIntegration(
  'UsageRefillService against real ClickHouse and Redis',
  () => {
    let clickHouseClient: ClickHouseClient;
    let prefixed: Redis.Redis;
    let raw: Redis.Redis;
    let events: MeteringEventsManager;
    let countersManager: UsageCountersManager;
    let sweepManager: MeteringSweepManager;
    let service: UsageRefillService;
    let now: Date;

    function event(id: string, slug: string, amount: number, offsetMs: number) {
      return {
        eventIdHash: hashEventId(id),
        clientId: CLIENT_ID,
        slug,
        subject: 'user-1',
        amount,
        eventTime: new Date(now.getTime() + offsetMs),
        ingestedAt: new Date(now.getTime() - 10_000),
      };
    }

    async function usageInClickHouse(slug: string): Promise<number> {
      const { windowStart, windowEnd } = resolveWindow(WINDOWS[slug], now);
      return events.sumUsage({
        clientId: CLIENT_ID,
        slug,
        subject: 'user-1',
        from: windowStart,
        to: windowEnd,
      });
    }

    async function usageInRedis(slug: string): Promise<number | undefined> {
      const counted = await countersManager.findWindowUsage(
        { clientId: CLIENT_ID, slug, subject: 'user-1' },
        WINDOWS[slug],
        now
      );
      return counted?.usage;
    }

    async function deleteTestKeys(): Promise<void> {
      const keys = await raw.keys(`${KEY_PREFIX}*`);
      if (keys.length > 0) {
        await raw.del(...keys);
      }
    }

    beforeAll(async () => {
      clickHouseClient = integrationClickHouseClient();
      prefixed = new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        keyPrefix: KEY_PREFIX,
      });
      raw = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
      events = new MeteringEventsManager(
        new MeteringEventsRepository(clickHouseClient)
      );

      const moduleRef = await Test.createTestingModule({
        providers: [
          UsageRefillService,
          UsageRefillManager,
          UsageRefillRepository,
          UsageCountersManager,
          MeteringSweepManager,
          MeteringSweepRepository,
          { provide: ClickHouseClient, useValue: clickHouseClient },
          { provide: MeteringRedisClient, useValue: prefixed },
          {
            provide: MeteringConfigurationManager,
            useValue: {
              getMeterBySlug: (slug: string) =>
                Promise.resolve(
                  WINDOWS[slug]
                    ? StrapiMeterFactory({ slug, window: WINDOWS[slug] })
                    : null
                ),
            },
          },
          { provide: MeteringSweepConfig, useValue: MockMeteringSweepConfig },
          { provide: MeteringRedisConfig, useValue: MockMeteringRedisConfig },
          {
            provide: MeteringUsageCountersConfig,
            useValue: MockMeteringUsageCountersConfig,
          },
          {
            provide: StatsDService,
            useValue: {
              increment: jest.fn(),
              timing: jest.fn(),
              gauge: jest.fn(),
            },
          },
          {
            provide: Logger,
            useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
          },
        ],
      }).compile();

      service = moduleRef.get(UsageRefillService);
      countersManager = moduleRef.get(UsageCountersManager);
      sweepManager = moduleRef.get(MeteringSweepManager);
    });

    beforeEach(async () => {
      now = new Date();
      await truncateMeteringTables(clickHouseClient);
      await deleteTestKeys();
    });

    afterAll(async () => {
      await deleteTestKeys();
      await prefixed.quit();
      await raw.quit();
    });

    describe('a full refill of an empty Redis', () => {
      beforeEach(async () => {
        await events.insertEvents([
          event('m1', 'monthly', 5, -30 * MINUTE_MS),
          event('m2', 'monthly', 7, -10 * MINUTE_MS),
          event('s1', 'sliding', 3, -90 * MINUTE_MS),
          event('s2', 'sliding', 4, -5 * MINUTE_MS),
        ]);
      });

      it('reports the refill', async () => {
        await expect(service.refillIfNeeded(now)).resolves.toBe('refilled');
      });

      it('serves the same calendar usage from Redis as ClickHouse sums', async () => {
        await service.refillIfNeeded(now);

        await expect(usageInRedis('monthly')).resolves.toBe(
          await usageInClickHouse('monthly')
        );
        await expect(usageInRedis('monthly')).resolves.toBe(12);
      });

      it('serves the same sliding usage from Redis as ClickHouse sums', async () => {
        await service.refillIfNeeded(now);

        await expect(usageInRedis('sliding')).resolves.toBe(
          await usageInClickHouse('sliding')
        );
      });

      it('stores the ingested events as duplicates', async () => {
        await service.refillIfNeeded(now);

        await expect(
          prefixed.get(
            `dedupe:${JSON.stringify([CLIENT_ID, hashEventId('m1')])}`
          )
        ).resolves.toBe('stored');
      });

      it('leaves ingest resumed and Redis marked fully populated', async () => {
        await service.refillIfNeeded(now);

        await expect(prefixed.get('ingest-paused')).resolves.toBeNull();
        await expect(prefixed.get('redis-fully-populated')).resolves.toBe(
          now.toISOString()
        );
      });

      it('only checks on the next run', async () => {
        await service.refillIfNeeded(now);

        await expect(service.refillIfNeeded(now)).resolves.toBe('checked');
      });
    });

    it('rebuilds an open session from its recorded start', async () => {
      const sessionStart = new Date(now.getTime() - 60 * MINUTE_MS);
      await sweepManager.recordSessionStarts([
        {
          clientId: CLIENT_ID,
          slug: 'session',
          subject: 'user-1',
          sessionStart,
        },
      ]);
      await events.insertEvents([
        event('before', 'session', 50, -61 * MINUTE_MS),
        event('inside', 'session', 9, -30 * MINUTE_MS),
      ]);

      await service.refillIfNeeded(now);

      await expect(
        countersManager.findWindowUsage(
          { clientId: CLIENT_ID, slug: 'session', subject: 'user-1' },
          WINDOWS['session'],
          now
        )
      ).resolves.toEqual({
        usage: 9,
        windowStart: sessionStart,
        windowEnd: new Date(sessionStart.getTime() + SESSION_DURATION_MS),
      });
    });

    it('repairs a counter that lost writes when the Redis run id changes', async () => {
      await events.insertEvents([event('m1', 'monthly', 5, -30 * MINUTE_MS)]);
      await service.refillIfNeeded(now);
      await events.insertEvents([event('m2', 'monthly', 7, -1 * MINUTE_MS)]);
      await prefixed.set('redis-run-id', 'run-before-failover');

      await expect(service.refillIfNeeded(now)).resolves.toBe('repaired');

      await expect(usageInRedis('monthly')).resolves.toBe(12);
    });

    it('rebuilds a meter whose window changed', async () => {
      await events.insertEvents([event('m1', 'monthly', 5, -30 * MINUTE_MS)]);
      await service.refillIfNeeded(now);
      await prefixed.set(
        'meter-window:["monthly"]',
        JSON.stringify({ kind: 'calendar', period: 'daily' })
      );
      await events.insertEvents([event('m2', 'monthly', 7, -1 * MINUTE_MS)]);

      await expect(service.refillIfNeeded(now)).resolves.toBe('meters-rebuilt');

      await expect(usageInRedis('monthly')).resolves.toBe(12);
    });
  }
);
