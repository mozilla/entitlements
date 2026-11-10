/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Logger, type LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  MeteringConfigurationManager,
  StrapiMeterFactory,
} from '@entitlements/shared/cms';
import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import {
  IngestUsageRequestFactory,
  UsageQueryParamsFactory,
} from './metering.factories';
import { MeteringEventsManager } from './metering-events.manager';
import { MeteringPublisherManager } from './metering-publisher.manager';
import { MeteringSweepManager } from './metering-sweep.manager';
import {
  ClickHouseRateLimitError,
  MeterNotConfiguredError,
  PublishError,
  TimestampOutOfRangeError,
  UsageCountersError,
} from './metering.error';
import { UsageCountersManager } from './usage-counters.manager';
import { UsageGrantsManager } from './usage-grants.manager';
import { UsageService } from './usage.service';

const CLIENT_ID = 'vpn';
const NOW = new Date('2026-05-15T12:00:00.000Z');

describe('UsageService', () => {
  let usageService: UsageService;
  let meteringConfigurationManager: jest.Mocked<
    Pick<MeteringConfigurationManager, 'getMeterBySlug'>
  >;
  let meteringPublisherManager: jest.Mocked<
    Pick<MeteringPublisherManager, 'publish'>
  >;
  let meteringEventsManager: jest.Mocked<
    Pick<MeteringEventsManager, 'sumUsage'>
  >;
  let meteringSweepManager: jest.Mocked<
    Pick<MeteringSweepManager, 'findSessionStarts'>
  >;
  let usageCountersManager: jest.Mocked<
    Pick<UsageCountersManager, 'findWindowUsage'>
  >;
  let usageGrantsManager: jest.Mocked<
    Pick<UsageGrantsManager, 'getActiveGrantedAmount'>
  >;
  let statsd: jest.Mocked<Pick<StatsD, 'increment'>>;
  let logger: jest.Mocked<Pick<LoggerService, 'error'>>;

  beforeEach(async () => {
    meteringConfigurationManager = { getMeterBySlug: jest.fn() };
    meteringPublisherManager = {
      publish: jest.fn().mockResolvedValue(undefined),
    };
    meteringEventsManager = {
      sumUsage: jest.fn().mockResolvedValue(0),
    };
    meteringSweepManager = {
      findSessionStarts: jest.fn().mockResolvedValue(new Map()),
    };
    usageCountersManager = {
      findWindowUsage: jest.fn().mockResolvedValue(undefined),
    };
    usageGrantsManager = {
      getActiveGrantedAmount: jest.fn().mockResolvedValue(0),
    };
    statsd = { increment: jest.fn() };
    logger = { error: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsageService,
        {
          provide: MeteringConfigurationManager,
          useValue: meteringConfigurationManager,
        },
        {
          provide: MeteringPublisherManager,
          useValue: meteringPublisherManager,
        },
        { provide: MeteringEventsManager, useValue: meteringEventsManager },
        { provide: MeteringSweepManager, useValue: meteringSweepManager },
        { provide: UsageCountersManager, useValue: usageCountersManager },
        { provide: UsageGrantsManager, useValue: usageGrantsManager },
        { provide: StatsDService, useValue: statsd },
        { provide: Logger, useValue: logger },
      ],
    }).compile();

    usageService = moduleRef.get(UsageService);
  });

  describe('ingestUsage', () => {
    it('publishes the event for a configured slug', async () => {
      const meter = StrapiMeterFactory();
      const timestamp = '2026-05-15T11:34:56.000Z';
      const ingestUsageRequest = IngestUsageRequestFactory({
        slug: meter.slug,
        timestamp,
      });
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

      await usageService.ingestUsage(CLIENT_ID, ingestUsageRequest, NOW);

      expect(meteringConfigurationManager.getMeterBySlug).toHaveBeenCalledWith(
        meter.slug
      );
      expect(meteringPublisherManager.publish).toHaveBeenCalledWith({
        id: ingestUsageRequest.id,
        clientId: CLIENT_ID,
        slug: meter.slug,
        subject: ingestUsageRequest.subject,
        amount: ingestUsageRequest.amount,
        timestamp,
      });
    });

    it('attributes the event to the authenticated client', async () => {
      const meter = StrapiMeterFactory();
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

      await usageService.ingestUsage(
        'relay',
        IngestUsageRequestFactory({ slug: meter.slug }),
        NOW
      );

      expect(meteringPublisherManager.publish).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'relay' })
      );
    });

    it('stamps the current time when the request omits a timestamp', async () => {
      const meter = StrapiMeterFactory();
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

      await usageService.ingestUsage(
        CLIENT_ID,
        IngestUsageRequestFactory({ slug: meter.slug, timestamp: undefined }),
        NOW
      );

      expect(meteringPublisherManager.publish).toHaveBeenCalledWith(
        expect.objectContaining({ timestamp: '2026-05-15T12:00:00.000Z' })
      );
    });

    it('rejects unknown slugs with MeterNotConfiguredError and publishes nothing', async () => {
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(null);

      await expect(
        usageService.ingestUsage(CLIENT_ID, IngestUsageRequestFactory(), NOW)
      ).rejects.toThrow(MeterNotConfiguredError);
      expect(meteringPublisherManager.publish).not.toHaveBeenCalled();
    });

    it('rejects a far-future timestamp that ClickHouse would silently saturate', async () => {
      const meter = StrapiMeterFactory();
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

      await expect(
        usageService.ingestUsage(
          CLIENT_ID,
          IngestUsageRequestFactory({
            slug: meter.slug,
            timestamp: '9999-01-01T00:00:00.000Z',
          }),
          NOW
        )
      ).rejects.toThrow(TimestampOutOfRangeError);
      expect(meteringPublisherManager.publish).not.toHaveBeenCalled();
    });

    it('rejects a timestamp older than the accepted backfill window', async () => {
      const meter = StrapiMeterFactory();
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

      await expect(
        usageService.ingestUsage(
          CLIENT_ID,
          IngestUsageRequestFactory({
            slug: meter.slug,
            timestamp: '2026-05-01T00:00:00.000Z',
          }),
          NOW
        )
      ).rejects.toThrow(TimestampOutOfRangeError);
    });

    it('rejects before looking the meter up, so a bad timestamp costs no CMS call', async () => {
      await expect(
        usageService.ingestUsage(
          CLIENT_ID,
          IngestUsageRequestFactory({ timestamp: '9999-01-01T00:00:00.000Z' }),
          NOW
        )
      ).rejects.toThrow(TimestampOutOfRangeError);
      expect(
        meteringConfigurationManager.getMeterBySlug
      ).not.toHaveBeenCalled();
    });

    it('propagates a publish failure so the caller can retry', async () => {
      const meter = StrapiMeterFactory();
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);
      meteringPublisherManager.publish.mockRejectedValue(
        new PublishError(new Error('pubsub down'))
      );

      await expect(
        usageService.ingestUsage(
          CLIENT_ID,
          IngestUsageRequestFactory({ slug: meter.slug }),
          NOW
        )
      ).rejects.toThrow(PublishError);
    });
  });

  describe('queryUsage', () => {
    const MONTHLY_WINDOW = {
      windowStart: new Date('2026-05-01T00:00:00.000Z'),
      windowEnd: new Date('2026-06-01T00:00:00.000Z'),
    };

    function monthlyMeter() {
      return StrapiMeterFactory({
        unit: 'tokens',
        limit: 1000,
        window: { kind: 'calendar', period: 'monthly' },
      });
    }

    describe('when Redis is fully populated', () => {
      it('returns the usage counted in Redis', async () => {
        const meter = monthlyMeter();
        const params = UsageQueryParamsFactory({ slug: meter.slug });
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);
        usageCountersManager.findWindowUsage.mockResolvedValue({
          ...MONTHLY_WINDOW,
          usage: 250,
        });

        await expect(
          usageService.queryUsage(CLIENT_ID, params, NOW)
        ).resolves.toEqual({
          usage: 250,
          limit: 1000,
          grantedAmount: 0,
          unit: 'tokens',
          windowStart: '2026-05-01T00:00:00.000Z',
          windowEnd: '2026-06-01T00:00:00.000Z',
        });
      });

      it('reads the counters for the authenticated client, meter and subject', async () => {
        const meter = monthlyMeter();
        const params = UsageQueryParamsFactory({ slug: meter.slug });
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

        await usageService.queryUsage('relay', params, NOW);

        expect(usageCountersManager.findWindowUsage).toHaveBeenCalledWith(
          { clientId: 'relay', slug: params.slug, subject: params.subject },
          meter.window,
          NOW
        );
      });

      it('does not query ClickHouse', async () => {
        const meter = monthlyMeter();
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);
        usageCountersManager.findWindowUsage.mockResolvedValue({
          ...MONTHLY_WINDOW,
          usage: 250,
        });

        await usageService.queryUsage(
          CLIENT_ID,
          UsageQueryParamsFactory({ slug: meter.slug }),
          NOW
        );

        expect(meteringEventsManager.sumUsage).not.toHaveBeenCalled();
        expect(statsd.increment).toHaveBeenCalledWith('metering.usage.source', {
          source: 'redis',
        });
      });

      it('raises the reported limit by the active granted amount', async () => {
        const meter = monthlyMeter();
        const params = UsageQueryParamsFactory({ slug: meter.slug });
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);
        usageCountersManager.findWindowUsage.mockResolvedValue({
          ...MONTHLY_WINDOW,
          usage: 250,
        });
        usageGrantsManager.getActiveGrantedAmount.mockResolvedValue(500);

        const result = await usageService.queryUsage(CLIENT_ID, params, NOW);

        expect(usageGrantsManager.getActiveGrantedAmount).toHaveBeenCalledWith(
          params.subject,
          params.slug,
          NOW
        );
        expect(result.limit).toBe(1500);
        expect(result.grantedAmount).toBe(500);
      });

      it('propagates a failure from the grants manager', async () => {
        const meter = monthlyMeter();
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);
        usageGrantsManager.getActiveGrantedAmount.mockRejectedValue(
          new Error('firestore unavailable')
        );

        await expect(
          usageService.queryUsage(
            CLIENT_ID,
            UsageQueryParamsFactory({ slug: meter.slug }),
            NOW
          )
        ).rejects.toThrow('firestore unavailable');
      });
    });

    describe('when Redis is not fully populated', () => {
      it('sums the window from ClickHouse', async () => {
        const meter = monthlyMeter();
        const params = UsageQueryParamsFactory({ slug: meter.slug });
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);
        meteringEventsManager.sumUsage.mockResolvedValue(250);

        const result = await usageService.queryUsage(CLIENT_ID, params, NOW);

        expect(meteringEventsManager.sumUsage).toHaveBeenCalledWith({
          clientId: CLIENT_ID,
          slug: params.slug,
          subject: params.subject,
          from: MONTHLY_WINDOW.windowStart,
          to: MONTHLY_WINDOW.windowEnd,
        });
        expect(result.usage).toBe(250);
      });

      it('counts the ClickHouse read in the source metric', async () => {
        const meter = monthlyMeter();
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

        await usageService.queryUsage(
          CLIENT_ID,
          UsageQueryParamsFactory({ slug: meter.slug }),
          NOW
        );

        expect(statsd.increment).toHaveBeenCalledWith('metering.usage.source', {
          source: 'clickhouse-not-populated',
        });
      });

      it('reads a sliding window that ends at the end of the current hour', async () => {
        const meter = StrapiMeterFactory({
          window: { kind: 'sliding', durationMs: 5 * 60 * 60 * 1000 },
        });
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

        const result = await usageService.queryUsage(
          CLIENT_ID,
          UsageQueryParamsFactory({ slug: meter.slug }),
          NOW
        );

        expect(meteringEventsManager.sumUsage).toHaveBeenCalledWith(
          expect.objectContaining({
            from: new Date('2026-05-15T08:00:00.000Z'),
            to: new Date('2026-05-15T13:00:00.000Z'),
          })
        );
        expect(result.windowStart).toBe('2026-05-15T08:00:00.000Z');
        expect(result.windowEnd).toBe('2026-05-15T13:00:00.000Z');
      });

      it('uses the open session as the window for a session meter', async () => {
        const meter = StrapiMeterFactory({
          window: { kind: 'session', durationMs: 30 * 60 * 1000 },
        });
        const params = UsageQueryParamsFactory({ slug: meter.slug });
        const sessionStart = new Date('2026-05-15T11:50:00.000Z');
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);
        meteringSweepManager.findSessionStarts.mockResolvedValue(
          new Map([[params.subject, sessionStart]])
        );

        const result = await usageService.queryUsage(CLIENT_ID, params, NOW);

        expect(meteringSweepManager.findSessionStarts).toHaveBeenCalledWith(
          {
            clientId: CLIENT_ID,
            slug: params.slug,
            subjects: [params.subject],
          },
          'usageFallback'
        );
        expect(meteringEventsManager.sumUsage).toHaveBeenCalledWith(
          expect.objectContaining({
            from: sessionStart,
            to: new Date('2026-05-15T12:20:00.000Z'),
          })
        );
        expect(result.windowStart).toBe('2026-05-15T11:50:00.000Z');
      });

      it('starts an empty window at now when a session meter subject has no open session', async () => {
        const meter = StrapiMeterFactory({
          window: { kind: 'session', durationMs: 30 * 60 * 1000 },
        });
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

        await usageService.queryUsage(
          CLIENT_ID,
          UsageQueryParamsFactory({ slug: meter.slug }),
          NOW
        );

        expect(meteringEventsManager.sumUsage).toHaveBeenCalledWith(
          expect.objectContaining({ from: NOW })
        );
      });

      it('does not look up session starts for a calendar meter', async () => {
        const meter = monthlyMeter();
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

        await usageService.queryUsage(
          CLIENT_ID,
          UsageQueryParamsFactory({ slug: meter.slug }),
          NOW
        );

        expect(meteringSweepManager.findSessionStarts).not.toHaveBeenCalled();
      });

      it('propagates a ClickHouse failure such as the fallback rate limit', async () => {
        const meter = monthlyMeter();
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);
        meteringEventsManager.sumUsage.mockRejectedValue(
          new ClickHouseRateLimitError('query')
        );

        await expect(
          usageService.queryUsage(
            CLIENT_ID,
            UsageQueryParamsFactory({ slug: meter.slug }),
            NOW
          )
        ).rejects.toThrow(ClickHouseRateLimitError);
      });
    });

    describe('when the Redis read fails', () => {
      beforeEach(() => {
        usageCountersManager.findWindowUsage.mockRejectedValue(
          new UsageCountersError('findWindowUsage', new Error('timeout'))
        );
      });

      it('falls back to ClickHouse', async () => {
        const meter = monthlyMeter();
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);
        meteringEventsManager.sumUsage.mockResolvedValue(250);

        const result = await usageService.queryUsage(
          CLIENT_ID,
          UsageQueryParamsFactory({ slug: meter.slug }),
          NOW
        );

        expect(result.usage).toBe(250);
      });

      it('logs the Redis failure and counts it in the source metric', async () => {
        const meter = monthlyMeter();
        meteringConfigurationManager.getMeterBySlug.mockResolvedValue(meter);

        await usageService.queryUsage(
          CLIENT_ID,
          UsageQueryParamsFactory({ slug: meter.slug }),
          NOW
        );

        expect(logger.error).toHaveBeenCalledWith(
          expect.any(UsageCountersError)
        );
        expect(statsd.increment).toHaveBeenCalledWith('metering.usage.source', {
          source: 'clickhouse-redis-error',
        });
      });
    });

    it('rejects unknown slugs with MeterNotConfiguredError', async () => {
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(null);

      await expect(
        usageService.queryUsage(CLIENT_ID, UsageQueryParamsFactory(), NOW)
      ).rejects.toThrow(MeterNotConfiguredError);
    });
  });
});
