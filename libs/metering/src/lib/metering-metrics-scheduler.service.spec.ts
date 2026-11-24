/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Logger } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { InMemoryLockStore, LocksModule, LocksStorage } from '@nestjs/locks';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { Registry } from '@prometheus-io/client';

import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';
import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import { MeteringMetricsSchedulerService } from './metering-metrics-scheduler.service';
import { MeteringMetricsService } from './metering-metrics.service';
import { MeteringMetricsSchedulerConfig } from './metering-scheduler.config';
import { MeteringSchedulerService } from './metering-scheduler.service';
import { MetricsReportMetrics } from './metering-metrics.metrics';
import { SchedulerMetrics } from './metering-scheduler.metrics';
import type { MetricsReportAllResult } from './metering.types';
import { metricValues } from '../testing';

jest.mock('@nestjs/schedule', () =>
  jest
    .requireActual('../testing')
    .withSentryCronWrapper(jest.requireActual('@nestjs/schedule'))
);

const METRICS_RESULT: MetricsReportAllResult = { total: 2, failed: 0 };
const OTHER_INSTANCE = 'other-instance';
const HELD_MS = 60_000;
const NEVER_DURING_TESTS: MeteringMetricsSchedulerConfig = {
  cron: '0 0 1 1 *',
};

describe('MeteringMetricsSchedulerService', () => {
  let moduleRef: TestingModule;
  let service: MeteringMetricsSchedulerService;
  let store: InMemoryLockStore;
  let metricsService: jest.Mocked<Pick<MeteringMetricsService, 'reportAll'>>;
  let statsd: jest.Mocked<Pick<StatsD, 'increment'>>;
  let logger: jest.Mocked<
    Pick<LoggerService, 'error' | 'log' | 'warn' | 'debug'>
  >;

  async function start(
    config: MeteringMetricsSchedulerConfig = NEVER_DURING_TESTS
  ): Promise<void> {
    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), LocksModule.forRoot()],
      providers: [
        MeteringMetricsSchedulerService,
        MeteringSchedulerService,
        { provide: MeteringMetricsSchedulerConfig, useValue: config },
        { provide: MeteringMetricsService, useValue: metricsService },
        { provide: StatsDService, useValue: statsd },
        { provide: PrometheusRegistry, useValue: new Registry() },
        MetricsReportMetrics,
        SchedulerMetrics,
        { provide: Logger, useValue: logger },
      ],
    }).compile();
    moduleRef.get(LocksStorage).registerSource(store);
    await moduleRef.init();
    service = moduleRef.get(MeteringMetricsSchedulerService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    store = new InMemoryLockStore();
    metricsService = {
      reportAll: jest.fn().mockResolvedValue(METRICS_RESULT),
    };
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
    const CONFIGURED: MeteringMetricsSchedulerConfig = { cron: '0 0 1 2 *' };

    beforeEach(async () => {
      await start(CONFIGURED);
    });

    it('schedules the metrics job on its configured cron', () => {
      const registry = moduleRef.get(SchedulerRegistry);

      expect(registry.getCronJob('metrics').cronTime.source).toBe(
        CONFIGURED.cron
      );
    });

    it('starts the metrics job', () => {
      const registry = moduleRef.get(SchedulerRegistry);

      expect(registry.getCronJob('metrics').isActive).toBe(true);
    });
  });

  describe('reportMetrics', () => {
    beforeEach(async () => {
      await start();
    });

    it('runs the metrics report', async () => {
      await service.reportMetrics();

      expect(metricsService.reportAll).toHaveBeenCalledTimes(1);
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

    describe('when another instance owns the metrics job', () => {
      beforeEach(async () => {
        await store.acquire('metrics:owner', OTHER_INSTANCE, HELD_MS);
      });

      it('does not report', async () => {
        await service.reportMetrics();

        expect(metricsService.reportAll).not.toHaveBeenCalled();
      });

      it('counts the run as skipped', async () => {
        await service.reportMetrics();

        expect(statsd.increment).toHaveBeenCalledWith(
          'metering.scheduler.skipped',
          { job: 'metrics', reason: 'ownership-unavailable' }
        );
      });

      it('clears the metrics gauges', async () => {
        moduleRef
          .get(MetricsReportMetrics)
          .meterLimit.set(
            { client_id: 'vpn', slug: 'tokens', unit: 'tokens' },
            100
          );

        await service.reportMetrics();

        expect(
          await metricValues(
            moduleRef.get(PrometheusRegistry),
            'metering_meter_limit'
          )
        ).toEqual([]);
      });
    });

    describe('when a report is still running on another instance', () => {
      beforeEach(async () => {
        await store.acquire('metrics', OTHER_INSTANCE, HELD_MS);
      });

      it('does not report', async () => {
        await service.reportMetrics();

        expect(metricsService.reportAll).not.toHaveBeenCalled();
      });

      it('counts the run as skipped', async () => {
        await service.reportMetrics();

        expect(statsd.increment).toHaveBeenCalledWith(
          'metering.scheduler.skipped',
          { job: 'metrics', reason: 'run-lock-unavailable' }
        );
      });

      it('keeps the metrics gauges', async () => {
        moduleRef
          .get(MetricsReportMetrics)
          .meterLimit.set(
            { client_id: 'vpn', slug: 'tokens', unit: 'tokens' },
            100
          );

        await service.reportMetrics();

        expect(
          await metricValues(
            moduleRef.get(PrometheusRegistry),
            'metering_meter_limit'
          )
        ).toEqual([
          {
            value: 100,
            labels: { client_id: 'vpn', slug: 'tokens', unit: 'tokens' },
          },
        ]);
      });
    });

    describe('when the lock store fails', () => {
      beforeEach(() => {
        jest
          .spyOn(store, 'acquire')
          .mockRejectedValue(new Error('ECONNREFUSED'));
      });

      it('rejects with the lock store error', async () => {
        await expect(service.reportMetrics()).rejects.toThrow(
          'the lock store failed (ECONNREFUSED)'
        );
      });

      it('does not report', async () => {
        await service.reportMetrics().catch(() => undefined);

        expect(metricsService.reportAll).not.toHaveBeenCalled();
      });
    });

    describe('when the report throws', () => {
      const failure = new Error('timeout');

      beforeEach(() => {
        metricsService.reportAll.mockRejectedValue(failure);
      });

      it('rethrows the error', async () => {
        await expect(service.reportMetrics()).rejects.toBe(failure);
      });

      it('counts the run as an error', async () => {
        await service.reportMetrics().catch(() => undefined);

        expect(statsd.increment).toHaveBeenCalledWith(
          'metering.scheduler.run',
          { job: 'metrics', outcome: 'error' }
        );
      });

      it('releases the metrics run lock', async () => {
        await service.reportMetrics().catch(() => undefined);

        expect(store.peek('metrics')).toBeUndefined();
      });
    });
  });
});
