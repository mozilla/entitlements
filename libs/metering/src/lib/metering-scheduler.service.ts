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
import { LocksEvents, OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';

import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import type { SchedulerJob, SchedulerRunOutcome } from './metering.types';
import { MeteringMetricsService } from './metering-metrics.service';
import { MeteringSweepService } from './metering-sweep.service';
import { UsageRefillService } from './usage-refill.service';

@Injectable()
export class MeteringSchedulerService implements OnModuleInit {
  constructor(
    private readonly locksEvents: LocksEvents,
    private readonly meteringSweepService: MeteringSweepService,
    private readonly meteringMetricsService: MeteringMetricsService,
    private readonly usageRefillService: UsageRefillService,
    @Inject(StatsDService) private readonly statsd: StatsD,
    @Inject(Logger) private readonly logger: LoggerService
  ) {}

  onModuleInit(): void {
    this.locksEvents.jobSkips$.subscribe(({ key, reason }) => {
      this.statsd.increment('metering.scheduler.skipped', { job: key, reason });
    });
    this.locksEvents.events$.subscribe((event) => {
      if (event.type !== 'lock-lost') {
        return;
      }
      this.statsd.increment('metering.scheduler.lock_lost', {
        key: event.key,
        detectedBy: event.detectedBy,
      });
      this.logger.warn(
        `Lock lost: ${event.key} (${event.detectedBy})`,
        'MeteringScheduler'
      );
    });
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'sweep', waitForCompletion: true })
  @OnOneInstance({ key: 'sweep' })
  @WithoutOverlapping()
  async sweep(): Promise<void> {
    await this.counted('sweep', async () => {
      const refilled = await this.refillUsageCounters();
      const result = await this.meteringSweepService.sweepAll();
      this.logger.log(
        `Swept ${result.total} meters: ${result.held} held, ${result.failed} failed`,
        'MeteringScheduler'
      );
      return result.failed > 0 || !refilled ? 'failed' : 'ok';
    });
  }

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'metrics',
    waitForCompletion: true,
  })
  @OnOneInstance({ key: 'metrics' })
  @WithoutOverlapping()
  async reportMetrics(): Promise<void> {
    await this.counted('metrics', async () => {
      const result = await this.meteringMetricsService.reportAll();
      this.logger.log(
        `Reported metrics for ${result.total} meters: ${result.failed} failed`,
        'MeteringScheduler'
      );
      return result.failed > 0 ? 'failed' : 'ok';
    });
  }

  private async refillUsageCounters(): Promise<boolean> {
    try {
      const outcome = await this.usageRefillService.refillIfNeeded();
      this.logger.log(`Usage refill outcome: ${outcome}`, 'UsageRefill');
      return true;
    } catch (err) {
      Sentry.captureException(err);
      this.logger.error(err, undefined, 'UsageRefill');
      return false;
    }
  }

  private async counted(
    job: SchedulerJob,
    fn: () => Promise<SchedulerRunOutcome>
  ): Promise<void> {
    try {
      const outcome = await fn();
      this.statsd.increment('metering.scheduler.run', { job, outcome });
    } catch (err) {
      this.statsd.increment('metering.scheduler.run', {
        job,
        outcome: 'error',
      });
      throw err;
    }
  }
}
