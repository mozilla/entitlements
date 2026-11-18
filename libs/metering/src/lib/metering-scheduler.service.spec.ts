/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Logger } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { LocksEvents, LocksModule } from '@nestjs/locks';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { CronJob } from 'cron';

import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import {
  MeteringSchedulerService,
  SCHEDULED_AT_BOOTSTRAP,
} from './metering-scheduler.service';

const CONFIGURED_CRON = '0 0 1 2 *';

describe('MeteringSchedulerService', () => {
  let moduleRef: TestingModule;
  let service: MeteringSchedulerService;
  let registry: SchedulerRegistry;
  let cronJob: CronJob;
  let statsd: jest.Mocked<Pick<StatsD, 'increment'>>;
  let logger: jest.Mocked<Pick<LoggerService, 'log' | 'warn' | 'debug'>>;

  beforeEach(async () => {
    statsd = { increment: jest.fn() };
    logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    moduleRef = await Test.createTestingModule({
      imports: [LocksModule.forRoot()],
      providers: [
        MeteringSchedulerService,
        SchedulerRegistry,
        { provide: StatsDService, useValue: statsd },
        { provide: Logger, useValue: logger },
      ],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(MeteringSchedulerService);
    registry = moduleRef.get(SchedulerRegistry);
    cronJob = CronJob.from({
      cronTime: SCHEDULED_AT_BOOTSTRAP,
      onTick: () => undefined,
      start: false,
    });
    registry.addCronJob('sweep', cronJob);
  });

  afterEach(async () => {
    cronJob.stop();
    await moduleRef.close();
  });

  describe('schedule', () => {
    it('sets the job to run on the given cron', () => {
      service.schedule('sweep', CONFIGURED_CRON);

      expect(cronJob.cronTime.source).toBe(CONFIGURED_CRON);
    });

    it('starts the job', () => {
      service.schedule('sweep', CONFIGURED_CRON);

      expect(cronJob.isActive).toBe(true);
    });

    it('logs the schedule', () => {
      service.schedule('sweep', CONFIGURED_CRON);

      expect(logger.log).toHaveBeenCalledWith(
        `Scheduled sweep on "${CONFIGURED_CRON}"`,
        'MeteringScheduler'
      );
    });

    it('throws for a job that is not registered', () => {
      expect(() => service.schedule('metrics', CONFIGURED_CRON)).toThrow(
        'metrics'
      );
    });
  });

  describe('run', () => {
    it.each(['ok', 'failed'] as const)(
      'counts a run with outcome %s',
      async (outcome) => {
        await service.run('sweep', async () => outcome);

        expect(statsd.increment).toHaveBeenCalledWith(
          'metering.scheduler.run',
          { job: 'sweep', outcome }
        );
      }
    );

    it('rethrows an error from the job', async () => {
      const failure = new Error('ClickHouse unavailable');

      await expect(
        service.run('sweep', () => Promise.reject(failure))
      ).rejects.toBe(failure);
    });

    it('counts a thrown run as an error', async () => {
      await service
        .run('sweep', () => Promise.reject(new Error('timeout')))
        .catch(() => undefined);

      expect(statsd.increment).toHaveBeenCalledWith('metering.scheduler.run', {
        job: 'sweep',
        outcome: 'error',
      });
    });
  });

  describe('lock events', () => {
    it('counts a skipped run by job and reason', () => {
      moduleRef.get(LocksEvents).emitJobSkipped({
        type: 'job-skipped',
        job: 'MeteringSweepSchedulerService.sweep',
        key: 'sweep',
        reason: 'ownership-unavailable',
      });

      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.scheduler.skipped',
        { job: 'sweep', reason: 'ownership-unavailable' }
      );
    });

    describe('when a lock is lost', () => {
      beforeEach(() => {
        moduleRef.get(LocksEvents).emit({
          type: 'lock-lost',
          key: 'sweep:owner',
          fencingToken: 7,
          detectedBy: 'renewal',
        });
      });

      it('counts the lost lock', () => {
        expect(statsd.increment).toHaveBeenCalledWith(
          'metering.scheduler.lock_lost',
          { key: 'sweep:owner', detectedBy: 'renewal' }
        );
      });

      it('logs the lost lock', () => {
        expect(logger.warn).toHaveBeenCalledWith(
          'Lock lost: sweep:owner (renewal)',
          'MeteringScheduler'
        );
      });
    });

    it('ignores events other than a lost lock', () => {
      moduleRef.get(LocksEvents).emit({
        type: 'leadership-acquired',
        key: 'sweep:owner',
        fencingToken: 7,
      });

      expect(statsd.increment).not.toHaveBeenCalled();
    });
  });
});
