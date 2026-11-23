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

import { MeteringMetricsService } from './metering-metrics.service';
import { MeteringMetricsSchedulerConfig } from './metering-scheduler.config';
import {
  MeteringSchedulerService,
  SCHEDULED_AT_BOOTSTRAP,
} from './metering-scheduler.service';

@Injectable()
export class MeteringMetricsSchedulerService implements OnApplicationBootstrap {
  constructor(
    private readonly meteringMetricsSchedulerConfig: MeteringMetricsSchedulerConfig,
    private readonly meteringSchedulerService: MeteringSchedulerService,
    private readonly meteringMetricsService: MeteringMetricsService,
    @Inject(Logger) private readonly logger: LoggerService
  ) {}

  onApplicationBootstrap(): void {
    this.meteringSchedulerService.schedule(
      'metrics',
      this.meteringMetricsSchedulerConfig.cron
    );
  }

  @OnOneInstance({ key: 'metrics' })
  @WithoutOverlapping()
  @Cron(SCHEDULED_AT_BOOTSTRAP, {
    name: 'metrics',
    waitForCompletion: true,
    disabled: true,
  })
  async reportMetrics(): Promise<void> {
    await this.meteringSchedulerService.run('metrics', async () => {
      const result = await this.meteringMetricsService.reportAll();
      this.logger.log(
        `Reported metrics for ${result.total} meters: ${result.failed} failed`,
        'MeteringScheduler'
      );
      return result.failed > 0 ? 'failed' : 'ok';
    });
  }
}
