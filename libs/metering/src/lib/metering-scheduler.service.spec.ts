/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Logger } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import {
  InMemoryLockStore,
  LocksEvents,
  LocksModule,
  LocksStorage,
} from '@nestjs/locks';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import * as Sentry from '@sentry/nestjs';

import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import { MeteringMetricsService } from './metering-metrics.service';
import { MeteringSchedulerConfig } from './metering-scheduler.config';
import { MeteringSchedulerService } from './metering-scheduler.service';
import { MeteringSweepService } from './metering-sweep.service';
import { UsageRefillService } from './usage-refill.service';
import type { MetricsReportAllResult, SweepAllResult } from './metering.types';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

const SWEEP_RESULT: SweepAllResult = { total: 3, held: 1, failed: 0 };
const METRICS_RESULT: MetricsReportAllResult = { total: 2, failed: 0 };
const OTHER_INSTANCE = 'other-instance';
const HELD_MS = 60_000;
const NEVER_DURING_TESTS: MeteringSchedulerConfig = {
  sweepCron: '0 0 1 1 *',
  metricsCron: '0 0 1 1 *',
};

describe('MeteringSchedulerService', () => {
  let moduleRef: TestingModule;
  let service: MeteringSchedulerService;
  let store: InMemoryLockStore;
  let sweepService: jest.Mocked<Pick<MeteringSweepService, 'sweepAll'>>;
  let metricsService: jest.Mocked<Pick<MeteringMetricsService, 'reportAll'>>;
  let refillService: jest.Mocked<Pick<UsageRefillService, 'refillIfNeeded'>>;
  let statsd: jest.Mocked<Pick<StatsD, 'increment'>>;
  let logger: jest.Mocked<Pick<LoggerService, 'error' | 'log' | 'warn' | 'debug'>>;

  async function start(
    schedules: MeteringSchedulerConfig = NEVER_DURING_TESTS
  ): Promise<void> {
    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), LocksModule.forRoot()],
      providers: [
        MeteringSchedulerService,
        { provide: MeteringSchedulerConfig, useValue: schedules },
        { provide: MeteringSweepService, useValue: sweepService },
        { provide: MeteringMetricsService, useValue: metricsService },
        { provide: UsageRefillService, useValue: refillService },
        { provide: StatsDService, useValue: statsd },
        { provide: Logger, useValue: logger },
      ],
    }).compile();
    moduleRef.get(LocksStorage).registerSource(store);
    await moduleRef.init();
    service = moduleRef.get(MeteringSchedulerService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    store = new InMemoryLockStore();
    sweepService = { sweepAll: jest.fn().mockResolvedValue(SWEEP_RESULT) };
    metricsService = {
      reportAll: jest.fn().mockResolvedValue(METRICS_RESULT),
    };
    refillService = { refillIfNeeded: jest.fn().mockResolvedValue('checked') };
    statsd = { increment: jest.fn() };
    logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  describe('schedule registration', () => {
    const CONFIGURED: MeteringSchedulerConfig = {
      sweepCron: '0 0 1 1 *',
      metricsCron: '0 0 1 2 *',
    };

    beforeEach(async () => {
      await start(CONFIGURED);
    });

    it.each([
      { job: 'sweep', cron: CONFIGURED.sweepCron },
      { job: 'metrics', cron: CONFIGURED.metricsCron },
    ])('schedules the $job job on its configured "$cron"', ({ job, cron }) => {
      const registry = moduleRef.get(SchedulerRegistry);

      expect(registry.getCronJob(job).cronTime.source).toBe(cron);
    });

    it.each(['sweep', 'metrics'])('starts the %s job', (job) => {
      const registry = moduleRef.get(SchedulerRegistry);

      expect(registry.getCronJob(job).isActive).toBe(true);
    });

    it.each([
      { job: 'sweep', cron: CONFIGURED.sweepCron },
      { job: 'metrics', cron: CONFIGURED.metricsCron },
    ])('logs the $job schedule', ({ job, cron }) => {
      expect(logger.log).toHaveBeenCalledWith(
        `Scheduled ${job} on "${cron}"`,
        'MeteringScheduler'
      );
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

      expect(store.peek('sweep:owner')).toBeDefined();
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
    });

    describe('when the lock store fails', () => {
      beforeEach(() => {
        jest
          .spyOn(store, 'acquire')
          .mockRejectedValue(new Error('ECONNREFUSED'));
      });

      it('rejects without running', async () => {
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

  describe('reportMetrics', () => {
    beforeEach(async () => {
      await start();
    });

    it('reports metrics for every swept meter', async () => {
      await service.reportMetrics();

      expect(metricsService.reportAll).toHaveBeenCalledTimes(1);
    });

    it('does not refill the usage counters', async () => {
      await service.reportMetrics();

      expect(refillService.refillIfNeeded).not.toHaveBeenCalled();
    });

    it('logs a summary of the report', async () => {
      await service.reportMetrics();

      expect(logger.log).toHaveBeenCalledWith(
        'Reported metrics for 2 meters: 0 failed',
        'MeteringScheduler'
      );
    });

    it('counts a report with no failures as ok', async () => {
      await service.reportMetrics();

      expect(statsd.increment).toHaveBeenCalledWith('metering.scheduler.run', {
        job: 'metrics',
        outcome: 'ok',
      });
    });

    it('counts a report with a failed meter as failed', async () => {
      metricsService.reportAll.mockResolvedValue({ total: 2, failed: 1 });

      await service.reportMetrics();

      expect(statsd.increment).toHaveBeenCalledWith('metering.scheduler.run', {
        job: 'metrics',
        outcome: 'failed',
      });
    });

    it('does not report when another instance owns the job', async () => {
      await store.acquire('metrics:owner', OTHER_INSTANCE, HELD_MS);

      await service.reportMetrics();

      expect(metricsService.reportAll).not.toHaveBeenCalled();
    });

    it('counts a thrown report as an error', async () => {
      metricsService.reportAll.mockRejectedValue(new Error('timeout'));

      await service.reportMetrics().catch(() => undefined);

      expect(statsd.increment).toHaveBeenCalledWith('metering.scheduler.run', {
        job: 'metrics',
        outcome: 'error',
      });
    });
  });

  describe('lost locks', () => {
    beforeEach(async () => {
      await start();
      moduleRef.get(LocksEvents).emit({
        type: 'lock-lost',
        key: 'sweep:owner',
        fencingToken: 7,
        detectedBy: 'renewal',
      });
    });

    it('counts a lost lock', () => {
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.scheduler.lock_lost',
        { key: 'sweep:owner', detectedBy: 'renewal' }
      );
    });

    it('logs a lost lock', () => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Lock lost: sweep:owner (renewal)',
        'MeteringScheduler'
      );
    });
  });
});
