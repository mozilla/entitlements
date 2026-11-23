/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  type LoggerService,
} from '@nestjs/common';
import { LocksEvents } from '@nestjs/locks';
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CronTime } from 'cron';

import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import { MeteringMetrics } from './metering.metrics';
import type { SchedulerJob, SchedulerRunOutcome } from './metering.types';

export const SCHEDULED_AT_BOOTSTRAP = CronExpression.EVERY_YEAR;

const SCHEDULER_JOBS: readonly string[] = ['sweep', 'metrics'];
const isSchedulerJob = (key: string): key is SchedulerJob =>
  SCHEDULER_JOBS.includes(key);

@Injectable()
export class MeteringSchedulerService implements OnModuleInit {
  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly locksEvents: LocksEvents,
    @Inject(StatsDService) private readonly statsd: StatsD,
    private readonly metrics: MeteringMetrics,
    @Inject(Logger) private readonly logger: LoggerService
  ) {}

  onModuleInit(): void {
    this.locksEvents.jobSkips$.subscribe(({ key, reason }) => {
      this.statsd.increment('metering.scheduler.skipped', { job: key, reason });
      this.metrics.schedulerSkips.inc({ job: key, reason });
      if (reason === 'ownership-unavailable' && isSchedulerJob(key)) {
        this.metrics.resetJobGauges(key);
      }
    });
    this.locksEvents.events$.subscribe((event) => {
      if (event.type !== 'lock-lost') {
        return;
      }
      this.statsd.increment('metering.scheduler.lock_lost', {
        key: event.key,
        detectedBy: event.detectedBy,
      });
      this.metrics.schedulerLockLost.inc({
        key: event.key,
        detected_by: event.detectedBy,
      });
      this.logger.warn(
        `Lock lost: ${event.key} (${event.detectedBy})`,
        'MeteringScheduler'
      );
    });
  }

  schedule(job: SchedulerJob, cron: string): void {
    const cronJob = this.schedulerRegistry.getCronJob(job);
    cronJob.setTime(new CronTime(cron));
    cronJob.start();
    this.logger.log(`Scheduled ${job} on "${cron}"`, 'MeteringScheduler');
  }

  async run(
    job: SchedulerJob,
    fn: () => Promise<SchedulerRunOutcome>
  ): Promise<void> {
    try {
      const outcome = await fn();
      this.statsd.increment('metering.scheduler.run', { job, outcome });
      this.metrics.schedulerRuns.inc({ job, outcome });
    } catch (err) {
      this.statsd.increment('metering.scheduler.run', {
        job,
        outcome: 'error',
      });
      this.metrics.schedulerRuns.inc({ job, outcome: 'error' });
      throw err;
    }
  }
}
