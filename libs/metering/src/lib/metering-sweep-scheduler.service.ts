/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  type LoggerService,
} from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';

import { MeteringSweepSchedulerConfig } from './metering-scheduler.config';
import {
  MeteringSchedulerService,
  SCHEDULED_AT_BOOTSTRAP,
} from './metering-scheduler.service';
import { MeteringSweepService } from './metering-sweep.service';
import { SweepMetrics } from './metering-sweep.metrics';
import { RefillMetrics } from './usage-refill.metrics';
import { UsageRefillService } from './usage-refill.service';

@Injectable()
export class MeteringSweepSchedulerService implements OnApplicationBootstrap {
  constructor(
    private readonly meteringSweepSchedulerConfig: MeteringSweepSchedulerConfig,
    private readonly meteringSchedulerService: MeteringSchedulerService,
    private readonly meteringSweepService: MeteringSweepService,
    private readonly usageRefillService: UsageRefillService,
    private readonly sweepMetrics: SweepMetrics,
    private readonly refillMetrics: RefillMetrics,
    @Inject(Logger) private readonly logger: LoggerService
  ) {}

  onApplicationBootstrap(): void {
    this.meteringSchedulerService.schedule(
      'sweep',
      this.meteringSweepSchedulerConfig.cron,
      () => {
        this.sweepMetrics.resetGauges();
        this.refillMetrics.resetGauges();
      }
    );
  }

  @OnOneInstance({ key: 'sweep' })
  @WithoutOverlapping()
  @Cron(SCHEDULED_AT_BOOTSTRAP, {
    name: 'sweep',
    waitForCompletion: true,
    disabled: true,
  })
  async sweep(): Promise<void> {
    await this.meteringSchedulerService.run('sweep', async () => {
      const refilled = await this.refillUsageCounters();
      const result = await this.meteringSweepService.sweepAll();
      this.logger.log(
        `Swept ${result.total} meters: ${result.held} held, ${result.failed} failed`,
        'MeteringScheduler'
      );
      return result.failed > 0 || !refilled ? 'failed' : 'ok';
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
}
