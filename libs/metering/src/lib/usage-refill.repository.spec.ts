/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Test } from '@nestjs/testing';

import { ClickHouseClient } from './clickhouse.client';
import {
  MeteringUsageCountersConfig,
  MockMeteringUsageCountersConfig,
} from './metering-usage-counters.config';
import { UsageRefillRepository } from './usage-refill.repository';

async function* rows<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of generator) {
    collected.push(item);
  }
  return collected;
}

const RANGE = {
  clientId: 'vpn',
  slug: 'chat',
  from: new Date('2026-11-01T00:00:00.000Z'),
  to: new Date('2026-11-05T13:42:00.000Z'),
  touchedSince: null,
};

describe('UsageRefillRepository', () => {
  let repository: UsageRefillRepository;
  let clickHouseClient: jest.Mocked<Pick<ClickHouseClient, 'stream'>>;

  function streamCall() {
    return clickHouseClient.stream.mock.calls[0][0];
  }

  beforeEach(async () => {
    clickHouseClient = { stream: jest.fn().mockReturnValue(rows([])) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsageRefillRepository,
        { provide: ClickHouseClient, useValue: clickHouseClient },
        {
          provide: MeteringUsageCountersConfig,
          useValue: MockMeteringUsageCountersConfig,
        },
      ],
    }).compile();

    repository = moduleRef.get(UsageRefillRepository);
  });

  it('streams with the refill time limit and sequential consistency', async () => {
    await collect(repository.streamDayTotals(RANGE));

    expect(streamCall().settings).toEqual({
      max_execution_time: MockMeteringUsageCountersConfig.refillTimeoutSeconds,
      select_sequential_consistency: 1,
    });
    expect(streamCall().timeoutMs).toBe(
      MockMeteringUsageCountersConfig.refillTimeoutSeconds * 1000
    );
  });

  describe('streamDayTotals', () => {
    it('yields the day totals', async () => {
      clickHouseClient.stream.mockReturnValue(
        rows([{ subject: 'user-1', day: '2026-11-05', usage: 12 }])
      );

      await expect(collect(repository.streamDayTotals(RANGE))).resolves.toEqual(
        [{ subject: 'user-1', day: '2026-11-05', usage: 12 }]
      );
    });

    it('binds the meter and event time range', async () => {
      await collect(repository.streamDayTotals(RANGE));

      expect(streamCall().params).toEqual({
        clientId: 'vpn',
        slug: 'chat',
        from: '2026-11-01 00:00:00.000',
        to: '2026-11-05 13:42:00.000',
      });
    });

    it('reads every subject for a full refill', async () => {
      await collect(repository.streamDayTotals(RANGE));

      expect(streamCall().sql).not.toContain('touchedSince');
    });

    it('reads only subjects with events ingested since the repair point', async () => {
      await collect(
        repository.streamDayTotals({
          ...RANGE,
          touchedSince: new Date('2026-11-05T13:30:00.000Z'),
        })
      );

      expect(streamCall().sql).toContain(
        "ingested_at >= {touchedSince:DateTime64(3, 'UTC')}"
      );
      expect(streamCall().params?.['touchedSince']).toBe(
        '2026-11-05 13:30:00.000'
      );
    });
  });

  describe('streamHourTotals', () => {
    it('groups by the start of each hour', async () => {
      await collect(repository.streamHourTotals(RANGE));

      expect(streamCall().sql).toContain('toStartOfHour(event_time)');
    });
  });

  describe('streamOpenSessions', () => {
    it('binds the session expiry boundary', async () => {
      await collect(
        repository.streamOpenSessions({
          clientId: 'vpn',
          slug: 'chat',
          expiredBefore: new Date('2026-11-05T08:37:00.000Z'),
          to: new Date('2026-11-05T13:42:00.000Z'),
          touchedSince: null,
        })
      );

      expect(streamCall().params).toEqual({
        clientId: 'vpn',
        slug: 'chat',
        expiredBefore: '2026-11-05 08:37:00.000',
        to: '2026-11-05 13:42:00.000',
      });
    });

    it('reads the latest start because the table can hold several rows per subject', async () => {
      await collect(
        repository.streamOpenSessions({
          clientId: 'vpn',
          slug: 'chat',
          expiredBefore: new Date('2026-11-05T08:37:00.000Z'),
          to: new Date('2026-11-05T13:42:00.000Z'),
          touchedSince: null,
        })
      );

      expect(streamCall().sql).toContain('max(session_start)');
    });
  });

  describe('streamIngestedEvents', () => {
    it('binds the ingest cutoff', async () => {
      await collect(
        repository.streamIngestedEvents(new Date('2026-11-04T12:37:00.000Z'))
      );

      expect(streamCall().params).toEqual({
        ingestedSince: '2026-11-04 12:37:00.000',
      });
    });
  });
});
