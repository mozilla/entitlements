/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Logger } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { InMemoryLockStore, LocksModule, LocksStorage } from '@nestjs/locks';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import * as Sentry from '@sentry/nestjs';
import { Registry } from '@prometheus-io/client';

import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';
import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import { MeteringSweepSchedulerConfig } from './metering-scheduler.config';
import { MeteringSchedulerService } from './metering-scheduler.service';
import { MeteringSweepSchedulerService } from './metering-sweep-scheduler.service';
import { MeteringSweepService } from './metering-sweep.service';
import {
  RefillMetrics,
  SchedulerMetrics,
  SweepMetrics,
} from './metering.metrics';
import { UsageRefillService } from './usage-refill.service';
import type { SweepAllResult } from './metering.types';
import { metricValues } from '../testing';

jest.mock('@nestjs/schedule', () =>
  jest
    .requireActual('../testing')
    .withSentryCronWrapper(jest.requireActual('@nestjs/schedule'))
);

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

const SWEEP_RESULT: SweepAllResult = { total: 3, held: 1, failed: 0 };
const OTHER_INSTANCE = 'other-instance';
const HELD_MS = 60_000;
const NEVER_DURING_TESTS: MeteringSweepSchedulerConfig = { cron: '0 0 1 1 *' };

describe('MeteringSweepSchedulerService', () => {
  let moduleRef: TestingModule;
  let service: MeteringSweepSchedulerService;
  let store: InMemoryLockStore;
  let sweepService: jest.Mocked<Pick<MeteringSweepService, 'sweepAll'>>;
  let refillService: jest.Mocked<Pick<UsageRefillService, 'refillIfNeeded'>>;
  let statsd: jest.Mocked<Pick<StatsD, 'increment'>>;
  let logger: jest.Mocked<
    Pick<LoggerService, 'error' | 'log' | 'warn' | 'debug'>
  >;

  async function start(
    config: MeteringSweepSchedulerConfig = NEVER_DURING_TESTS
  ): Promise<void> {
    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), LocksModule.forRoot()],
      providers: [
        MeteringSweepSchedulerService,
        MeteringSchedulerService,
        { provide: MeteringSweepSchedulerConfig, useValue: config },
        { provide: MeteringSweepService, useValue: sweepService },
        { provide: UsageRefillService, useValue: refillService },
        { provide: StatsDService, useValue: statsd },
        { provide: PrometheusRegistry, useValue: new Registry() },
        RefillMetrics,
        SchedulerMetrics,
        SweepMetrics,
        { provide: Logger, useValue: logger },
      ],
    }).compile();
    moduleRef.get(LocksStorage).registerSource(store);
    await moduleRef.init();
    service = moduleRef.get(MeteringSweepSchedulerService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    store = new InMemoryLockStore();
    sweepService = { sweepAll: jest.fn().mockResolvedValue(SWEEP_RESULT) };
    refillService = { refillIfNeeded: jest.fn().mockResolvedValue('checked') };
    statsd = { increment: jest.fn() };
    logger = {
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  describe('schedule registration', () => {
    const CONFIGURED: MeteringSweepSchedulerConfig = { cron: '0 0 1 2 *' };

    beforeEach(async () => {
      await start(CONFIGURED);
    });

    it('schedules the sweep job on its configured cron', () => {
      const registry = moduleRef.get(SchedulerRegistry);

      expect(registry.getCronJob('sweep').cronTime.source).toBe(
        CONFIGURED.cron
      );
    });

    it('starts the sweep job', () => {
      const registry = moduleRef.get(SchedulerRegistry);

      expect(registry.getCronJob('sweep').isActive).toBe(true);
    });
  });

  describe('sweep', () => {
    beforeEach(async () => {
      await start();
    });

    it('refills the usage counters before sweeping', async () => {
      const calls: string[] = [];
      refillService.refillIfNeeded.mockImplementation(async () => {
        calls.push('refill');
        return 'checked';
      });
      sweepService.sweepAll.mockImplementation(async () => {
        calls.push('sweep');
        return SWEEP_RESULT;
      });

      await service.sweep();

      expect(calls).toEqual(['refill', 'sweep']);
    });

    it('logs the refill outcome', async () => {
      refillService.refillIfNeeded.mockResolvedValue('refilled');

      await service.sweep();

      expect(logger.log).toHaveBeenCalledWith(
        'Usage refill outcome: refilled',
        'UsageRefill'
      );
    });

    it('logs a summary of the sweep', async () => {
      await service.sweep();

      expect(logger.log).toHaveBeenCalledWith(
        'Swept 3 meters: 1 held, 0 failed',
        'MeteringScheduler'
      );
    });

    it('counts a sweep with no failures as ok', async () => {
      await service.sweep();

      expect(statsd.increment).toHaveBeenCalledWith('metering.scheduler.run', {
        job: 'sweep',
        outcome: 'ok',
      });
    });

    it('counts a sweep with a failed meter as failed', async () => {
      sweepService.sweepAll.mockResolvedValue({ ...SWEEP_RESULT, failed: 1 });

      await service.sweep();

      expect(statsd.increment).toHaveBeenCalledWith('metering.scheduler.run', {
        job: 'sweep',
        outcome: 'failed',
      });
    });

    it('keeps the sweep lease after the run', async () => {
      await service.sweep();

      expect(store.peek('sweep:owner')).toEqual({
        owner: expect.any(String),
        fencingToken: 1,
        expiresAt: expect.any(Number),
      });
    });

    it('releases the sweep run lock after the run', async () => {
      await service.sweep();

      expect(store.peek('sweep')).toBeUndefined();
    });

    describe('when the refill fails', () => {
      const failure = new Error('Redis unavailable');

      beforeEach(() => {
        refillService.refillIfNeeded.mockRejectedValue(failure);
      });

      it('still sweeps', async () => {
        await service.sweep();

        expect(sweepService.sweepAll).toHaveBeenCalledTimes(1);
      });

      it('reports the refill error to Sentry', async () => {
        await service.sweep();

        expect(Sentry.captureException).toHaveBeenCalledWith(failure);
      });

      it('logs the refill error', async () => {
        await service.sweep();

        expect(logger.error).toHaveBeenCalledWith(
          failure,
          undefined,
          'UsageRefill'
        );
      });

      it('counts the sweep as failed', async () => {
        await service.sweep();

        expect(statsd.increment).toHaveBeenCalledWith(
          'metering.scheduler.run',
          { job: 'sweep', outcome: 'failed' }
        );
      });
    });

    describe('when another instance owns the sweep', () => {
      beforeEach(async () => {
        await store.acquire('sweep:owner', OTHER_INSTANCE, HELD_MS);
      });

      it('does not refill the usage counters', async () => {
        await service.sweep();

        expect(refillService.refillIfNeeded).not.toHaveBeenCalled();
      });

      it('does not sweep', async () => {
        await service.sweep();

        expect(sweepService.sweepAll).not.toHaveBeenCalled();
      });

      it('counts the run as skipped', async () => {
        await service.sweep();

        expect(statsd.increment).toHaveBeenCalledWith(
          'metering.scheduler.skipped',
          { job: 'sweep', reason: 'ownership-unavailable' }
        );
      });

      it('clears the watermark age gauge', async () => {
        moduleRef.get(SweepMetrics).watermarkAge.set({ slug: 'tokens' }, 60);

        await service.sweep();

        expect(
          await metricValues(
            moduleRef.get(PrometheusRegistry),
            'metering_sweep_watermark_age_seconds'
          )
        ).toEqual([]);
      });

      it('zeroes the refill gauges', async () => {
        moduleRef.get(RefillMetrics).counters.set(12);

        await service.sweep();

        expect(
          await metricValues(
            moduleRef.get(PrometheusRegistry),
            'metering_refill_counters'
          )
        ).toEqual([{ value: 0, labels: {} }]);
      });
    });

    describe('when a sweep is still running on another instance', () => {
      beforeEach(async () => {
        await store.acquire('sweep', OTHER_INSTANCE, HELD_MS);
      });

      it('does not sweep', async () => {
        await service.sweep();

        expect(sweepService.sweepAll).not.toHaveBeenCalled();
      });

      it('counts the run as skipped', async () => {
        await service.sweep();

        expect(statsd.increment).toHaveBeenCalledWith(
          'metering.scheduler.skipped',
          { job: 'sweep', reason: 'run-lock-unavailable' }
        );
      });

      it('keeps the watermark age gauge', async () => {
        moduleRef.get(SweepMetrics).watermarkAge.set({ slug: 'tokens' }, 60);

        await service.sweep();

        expect(
          await metricValues(
            moduleRef.get(PrometheusRegistry),
            'metering_sweep_watermark_age_seconds'
          )
        ).toEqual([{ value: 60, labels: { slug: 'tokens' } }]);
      });
    });

    describe('when the lock store fails', () => {
      beforeEach(() => {
        jest
          .spyOn(store, 'acquire')
          .mockRejectedValue(new Error('ECONNREFUSED'));
      });

      it('rejects with the lock store error', async () => {
        await expect(service.sweep()).rejects.toThrow(
          'the lock store failed (ECONNREFUSED)'
        );
      });

      it('does not sweep', async () => {
        await service.sweep().catch(() => undefined);

        expect(sweepService.sweepAll).not.toHaveBeenCalled();
      });
    });

    describe('when the sweep throws', () => {
      const failure = new Error('ClickHouse unavailable');

      beforeEach(() => {
        sweepService.sweepAll.mockRejectedValue(failure);
      });

      it('rethrows the error', async () => {
        await expect(service.sweep()).rejects.toBe(failure);
      });

      it('counts the run as an error', async () => {
        await service.sweep().catch(() => undefined);

        expect(statsd.increment).toHaveBeenCalledWith(
          'metering.scheduler.run',
          { job: 'sweep', outcome: 'error' }
        );
      });

      it('releases the sweep run lock', async () => {
        await service.sweep().catch(() => undefined);

        expect(store.peek('sweep')).toBeUndefined();
      });
    });
  });
});
