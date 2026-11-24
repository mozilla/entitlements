/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Logger, type LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Registry } from '@prometheus-io/client';

import {
  MeteringConfigurationManager,
  StrapiMeterFactory,
  type MeteringWindow,
} from '@entitlements/shared/cms';
import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';
import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import {
  MeteringRedisConfig,
  MockMeteringRedisConfig,
} from './metering-redis.config';
import {
  MeteringSweepConfig,
  MockMeteringSweepConfig,
} from './metering-sweep.config';
import { MeteringSweepManager } from './metering-sweep.manager';
import {
  MeteringUsageCountersConfig,
  MockMeteringUsageCountersConfig,
} from './metering-usage-counters.config';
import { ClickHouseError } from './metering.error';
import { RefillMetrics } from './usage-refill.metrics';
import {
  UsageCountersManager,
  type PopulationState,
} from './usage-counters.manager';
import { UsageRefillManager } from './usage-refill.manager';
import { UsageRefillService } from './usage-refill.service';
import { incrementedMetricValues, metricValues } from '../testing';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
  withScope: jest.fn((callback: (scope: unknown) => void) =>
    callback({ setTag: jest.fn() })
  ),
}));

const NOW = new Date('2026-11-05T13:37:00.000Z');
const RUN_ID = 'run-a';
const MONTHLY: MeteringWindow = { kind: 'calendar', period: 'monthly' };
const MONTHLY_FINGERPRINT = JSON.stringify(MONTHLY);
const CHAT = { clientId: 'vpn', slug: 'chat' };
const BROKEN = { clientId: 'vpn', slug: 'broken' };

const POPULATED: PopulationState = {
  fullyPopulated: true,
  runId: RUN_ID,
  checkedAt: new Date('2026-11-05T13:36:00.000Z'),
};

describe('UsageRefillService', () => {
  let service: UsageRefillService;
  let meteringConfigurationManager: jest.Mocked<
    Pick<MeteringConfigurationManager, 'getMeterBySlug'>
  >;
  let meteringSweepManager: jest.Mocked<
    Pick<MeteringSweepManager, 'findActiveMeters'>
  >;
  let countersManager: jest.Mocked<
    Pick<
      UsageCountersManager,
      | 'findRedisRunId'
      | 'findPopulationState'
      | 'findMeterWindowFingerprints'
      | 'recordMeterWindowFingerprints'
      | 'pauseIngest'
      | 'resumeIngest'
      | 'markFullyPopulated'
      | 'markChecked'
    >
  >;
  let refillManager: jest.Mocked<
    Pick<UsageRefillManager, 'refillMeter' | 'refillDedupeKeys'>
  >;
  let statsd: jest.Mocked<Pick<StatsD, 'increment' | 'timing' | 'gauge'>>;
  let registry: Registry;
  let logger: jest.Mocked<Pick<LoggerService, 'log' | 'warn' | 'error'>>;

  beforeEach(async () => {
    registry = new Registry();
    meteringConfigurationManager = {
      getMeterBySlug: jest
        .fn()
        .mockImplementation((slug: string) =>
          Promise.resolve(StrapiMeterFactory({ slug, window: MONTHLY }))
        ),
    };
    meteringSweepManager = {
      findActiveMeters: jest.fn().mockResolvedValue([CHAT]),
    };
    countersManager = {
      findRedisRunId: jest.fn().mockResolvedValue(RUN_ID),
      findPopulationState: jest.fn().mockResolvedValue(POPULATED),
      findMeterWindowFingerprints: jest
        .fn()
        .mockResolvedValue(new Map([['chat', MONTHLY_FINGERPRINT]])),
      recordMeterWindowFingerprints: jest.fn().mockResolvedValue(undefined),
      pauseIngest: jest.fn().mockResolvedValue(undefined),
      resumeIngest: jest.fn().mockResolvedValue(undefined),
      markFullyPopulated: jest.fn().mockResolvedValue(undefined),
      markChecked: jest.fn().mockResolvedValue(undefined),
    };
    refillManager = {
      refillMeter: jest
        .fn()
        .mockResolvedValue({ counters: 3, sessions: 0, dedupeKeys: 0 }),
      refillDedupeKeys: jest.fn().mockResolvedValue(4),
    };
    statsd = { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsageRefillService,
        {
          provide: MeteringConfigurationManager,
          useValue: meteringConfigurationManager,
        },
        { provide: MeteringSweepManager, useValue: meteringSweepManager },
        { provide: MeteringSweepConfig, useValue: MockMeteringSweepConfig },
        { provide: MeteringRedisConfig, useValue: MockMeteringRedisConfig },
        {
          provide: MeteringUsageCountersConfig,
          useValue: MockMeteringUsageCountersConfig,
        },
        { provide: UsageCountersManager, useValue: countersManager },
        { provide: UsageRefillManager, useValue: refillManager },
        { provide: StatsDService, useValue: statsd },
        { provide: PrometheusRegistry, useValue: registry },
        RefillMetrics,
        { provide: Logger, useValue: logger },
      ],
    }).compile();

    service = moduleRef.get(UsageRefillService);
  });

  describe('when Redis is fully populated and unchanged', () => {
    it('only records the check', async () => {
      await expect(service.refillIfNeeded(NOW)).resolves.toBe('checked');

      expect(refillManager.refillMeter).not.toHaveBeenCalled();
      expect(countersManager.pauseIngest).not.toHaveBeenCalled();
      expect(countersManager.markChecked).toHaveBeenCalledWith(RUN_ID, NOW);
    });

    it('counts the outcome', async () => {
      await service.refillIfNeeded(NOW);

      expect(statsd.increment).toHaveBeenCalledWith('metering.refill', {
        outcome: 'checked',
      });
    });

    it('records the outcome in Prometheus', async () => {
      await service.refillIfNeeded(NOW);

      expect(
        await incrementedMetricValues(registry, 'metering_refill_total')
      ).toEqual([{ value: 1, labels: { outcome: 'checked' } }]);
    });

    it('times the refill by outcome in Prometheus', async () => {
      await service.refillIfNeeded(NOW);

      expect(
        (await metricValues(registry, 'metering_refill_duration_seconds')).find(
          ({ metricName }) =>
            metricName === 'metering_refill_duration_seconds_count'
        )
      ).toEqual({
        metricName: 'metering_refill_duration_seconds_count',
        value: 1,
        labels: { outcome: 'checked' },
      });
    });
  });

  describe('when Redis is not fully populated', () => {
    beforeEach(() => {
      countersManager.findPopulationState.mockResolvedValue({
        fullyPopulated: false,
        runId: null,
        checkedAt: null,
      });
    });

    it('refills every configured active meter for all subjects', async () => {
      await expect(service.refillIfNeeded(NOW)).resolves.toBe('refilled');

      expect(refillManager.refillMeter).toHaveBeenCalledWith(
        { ...CHAT, window: MONTHLY },
        null,
        NOW
      );
    });

    it.each([
      { name: 'metering_refill_counters', value: 3 },
      { name: 'metering_refill_sessions', value: 0 },
      { name: 'metering_refill_dedupe_keys', value: 4 },
    ])('sets $name to $value in Prometheus', async ({ name, value }) => {
      await service.refillIfNeeded(NOW);

      expect(await metricValues(registry, name)).toEqual([
        { value, labels: {} },
      ]);
    });

    it('rebuilds the dedupe keys of the whole dedupe TTL', async () => {
      await service.refillIfNeeded(NOW);

      expect(refillManager.refillDedupeKeys).toHaveBeenCalledWith(
        new Date(
          NOW.getTime() - MockMeteringRedisConfig.dedupeTtlSeconds * 1000
        ),
        NOW
      );
    });

    it('looks up the meters after pausing ingest', async () => {
      await service.refillIfNeeded(NOW);

      expect(
        countersManager.pauseIngest.mock.invocationCallOrder[0]
      ).toBeLessThan(
        meteringSweepManager.findActiveMeters.mock.invocationCallOrder[0]
      );
    });

    it('pauses ingest during the refill and resumes it afterwards', async () => {
      await service.refillIfNeeded(NOW);

      expect(countersManager.pauseIngest).toHaveBeenCalledWith(
        MockMeteringUsageCountersConfig.ingestPauseTtlSeconds,
        NOW
      );
      expect(countersManager.resumeIngest).toHaveBeenCalledTimes(1);
      expect(
        countersManager.pauseIngest.mock.invocationCallOrder[0]
      ).toBeLessThan(refillManager.refillMeter.mock.invocationCallOrder[0]);
    });

    it('marks Redis fully populated and records the meter fingerprints once done', async () => {
      await service.refillIfNeeded(NOW);

      expect(
        countersManager.recordMeterWindowFingerprints
      ).toHaveBeenCalledWith(new Map([['chat', MONTHLY_FINGERPRINT]]));
      expect(countersManager.markFullyPopulated).toHaveBeenCalledWith(
        RUN_ID,
        NOW
      );
    });

    it('skips a meter that is no longer configured', async () => {
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(null);

      await service.refillIfNeeded(NOW);

      expect(refillManager.refillMeter).not.toHaveBeenCalled();
    });

    it('resumes ingest but does not mark Redis populated when the refill fails', async () => {
      refillManager.refillMeter.mockRejectedValue(
        new ClickHouseError('stream', new Error('timeout'))
      );

      await expect(service.refillIfNeeded(NOW)).rejects.toThrow(
        ClickHouseError
      );
      expect(countersManager.resumeIngest).toHaveBeenCalledTimes(1);
      expect(countersManager.markFullyPopulated).not.toHaveBeenCalled();
    });
  });

  describe('when the Redis run id changed', () => {
    beforeEach(() => {
      countersManager.findRedisRunId.mockResolvedValue('run-b');
    });

    it('repairs data ingested since the last check minus the margin', async () => {
      const since = new Date(
        Date.parse('2026-11-05T13:36:00.000Z') -
          MockMeteringUsageCountersConfig.repairMarginMs
      );

      await expect(service.refillIfNeeded(NOW)).resolves.toBe('repaired');

      expect(refillManager.refillMeter).toHaveBeenCalledWith(
        { ...CHAT, window: MONTHLY },
        since,
        NOW
      );
      expect(refillManager.refillDedupeKeys).toHaveBeenCalledWith(since, NOW);
    });

    it('records the new run id without marking a full refill', async () => {
      await service.refillIfNeeded(NOW);

      expect(countersManager.markChecked).toHaveBeenCalledWith('run-b', NOW);
      expect(countersManager.markFullyPopulated).not.toHaveBeenCalled();
    });
  });

  describe('when a meter window changed', () => {
    beforeEach(() => {
      countersManager.findMeterWindowFingerprints.mockResolvedValue(
        new Map([['chat', '{"kind":"sliding","durationMs":3600000}']])
      );
    });

    it('rebuilds only that meter for all subjects', async () => {
      meteringSweepManager.findActiveMeters.mockResolvedValue([
        CHAT,
        { clientId: 'vpn', slug: 'steady' },
      ]);
      countersManager.findMeterWindowFingerprints.mockResolvedValue(
        new Map([
          ['chat', '{"kind":"sliding","durationMs":3600000}'],
          ['steady', MONTHLY_FINGERPRINT],
        ])
      );

      await expect(service.refillIfNeeded(NOW)).resolves.toBe('meters-rebuilt');

      expect(refillManager.refillMeter.mock.calls).toEqual([
        [{ ...CHAT, window: MONTHLY }, null, NOW],
      ]);
    });

    it('does not rebuild dedupe keys', async () => {
      await service.refillIfNeeded(NOW);

      expect(refillManager.refillDedupeKeys).not.toHaveBeenCalled();
    });

    it('records the new fingerprint', async () => {
      await service.refillIfNeeded(NOW);

      expect(
        countersManager.recordMeterWindowFingerprints
      ).toHaveBeenCalledWith(new Map([['chat', MONTHLY_FINGERPRINT]]));
    });

    it('rebuilds a meter whose lookup failed during the last refill', async () => {
      countersManager.findMeterWindowFingerprints.mockResolvedValue(
        new Map([['chat', 'unavailable']])
      );

      await expect(service.refillIfNeeded(NOW)).resolves.toBe('meters-rebuilt');
    });
  });

  describe('when a meter is seen for the first time', () => {
    beforeEach(() => {
      countersManager.findMeterWindowFingerprints.mockResolvedValue(
        new Map([['chat', null]])
      );
    });

    it('does not rebuild it or pause ingest', async () => {
      await expect(service.refillIfNeeded(NOW)).resolves.toBe('checked');

      expect(refillManager.refillMeter).not.toHaveBeenCalled();
      expect(countersManager.pauseIngest).not.toHaveBeenCalled();
    });

    it('records its fingerprint', async () => {
      await service.refillIfNeeded(NOW);

      expect(
        countersManager.recordMeterWindowFingerprints
      ).toHaveBeenCalledWith(new Map([['chat', MONTHLY_FINGERPRINT]]));
    });
  });

  describe('when a meter lookup fails', () => {
    beforeEach(() => {
      meteringSweepManager.findActiveMeters.mockResolvedValue([CHAT, BROKEN]);
      meteringConfigurationManager.getMeterBySlug.mockImplementation(
        (slug: string) =>
          slug === BROKEN.slug
            ? Promise.reject(new Error('invalid meter'))
            : Promise.resolve(StrapiMeterFactory({ slug, window: MONTHLY }))
      );
    });

    it('counts the failure for that meter', async () => {
      await service.refillIfNeeded(NOW);

      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.refill.meter_error',
        { slug: 'broken' }
      );
    });

    it('records the failure for that meter in Prometheus', async () => {
      await service.refillIfNeeded(NOW);

      expect(
        await metricValues(registry, 'metering_refill_meter_errors_total')
      ).toEqual([{ value: 1, labels: { slug: 'broken' } }]);
    });

    describe('while Redis is not fully populated', () => {
      beforeEach(() => {
        countersManager.findPopulationState.mockResolvedValue({
          fullyPopulated: false,
          runId: null,
          checkedAt: null,
        });
      });

      it('refills the other meters and marks Redis fully populated', async () => {
        await expect(service.refillIfNeeded(NOW)).resolves.toBe('refilled');

        expect(refillManager.refillMeter.mock.calls).toEqual([
          [{ ...CHAT, window: MONTHLY }, null, NOW],
        ]);
        expect(countersManager.markFullyPopulated).toHaveBeenCalledWith(
          RUN_ID,
          NOW
        );
      });

      it('records the failed meter as unavailable so a later run rebuilds it', async () => {
        await service.refillIfNeeded(NOW);

        expect(
          countersManager.recordMeterWindowFingerprints
        ).toHaveBeenCalledWith(
          new Map([
            ['broken', 'unavailable'],
            ['chat', MONTHLY_FINGERPRINT],
          ])
        );
      });
    });

    it('records the failed meter as unavailable after a repair', async () => {
      countersManager.findRedisRunId.mockResolvedValue('run-b');

      await expect(service.refillIfNeeded(NOW)).resolves.toBe('repaired');

      expect(
        countersManager.recordMeterWindowFingerprints
      ).toHaveBeenCalledWith(new Map([['broken', 'unavailable']]));
    });

    it('leaves the failed meter fingerprint as it is while Redis is fully populated', async () => {
      countersManager.findMeterWindowFingerprints.mockResolvedValue(
        new Map([['chat', MONTHLY_FINGERPRINT]])
      );

      await expect(service.refillIfNeeded(NOW)).resolves.toBe('checked');

      const recordedSlugs =
        countersManager.recordMeterWindowFingerprints.mock.calls.flatMap(
          ([fingerprints]) => Array.from(fingerprints.keys())
        );
      expect(recordedSlugs).not.toContain('broken');
    });
  });

  it('looks for meters active within what a sweep would read back', async () => {
    await service.refillIfNeeded(NOW);

    expect(meteringSweepManager.findActiveMeters).toHaveBeenCalledWith({
      ingestedSince: new Date(
        NOW.getTime() -
          MockMeteringSweepConfig.lookbackMs -
          MockMeteringSweepConfig.watermarkLagMs
      ),
    });
  });

  it('propagates a failure to read the Redis run id', async () => {
    countersManager.findRedisRunId.mockRejectedValue(new Error('NOPERM'));

    await expect(service.refillIfNeeded(NOW)).rejects.toThrow('NOPERM');
  });
});
