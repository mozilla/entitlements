/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LocksModule } from '@nestjs/locks';
import { ScheduleModule } from '@nestjs/schedule';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';

import {
  ClickHouseClient,
  ClickHouseRateLimitersProvider,
  MeteringFirestoreProvider,
  MeteringLockRedisClientProvider,
  MeteringLockStore,
  MeteringMetricsManager,
  MeteringMetricsRepository,
  MeteringMetricsService,
  MeteringRedisClientProvider,
  MeteringSchedulerService,
  MeteringSweepManager,
  MeteringSweepRepository,
  MeteringSweepService,
  MeteringWebhookManager,
  UsageCountersManager,
  UsageGrantsManager,
  UsageRefillManager,
  UsageRefillRepository,
  UsageRefillService,
} from '@entitlements/metering';
import {
  MeteringConfigurationManager,
  StrapiClient,
} from '@entitlements/shared/cms';
import { FirestoreProvider } from '@entitlements/shared/db/firestore';
import {
  StatsDProvider,
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import { RootConfigModule } from '../config/config.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    LocksModule.forRoot(),
    SentryModule.forRoot(),
    RootConfigModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
    Logger,
    AppService,
    ClickHouseClient,
    ClickHouseRateLimitersProvider,
    FirestoreProvider,
    MeteringConfigurationManager,
    MeteringFirestoreProvider,
    MeteringLockRedisClientProvider,
    MeteringLockStore,
    MeteringMetricsManager,
    MeteringMetricsRepository,
    MeteringMetricsService,
    MeteringRedisClientProvider,
    MeteringSchedulerService,
    MeteringSweepManager,
    MeteringSweepRepository,
    MeteringSweepService,
    MeteringWebhookManager,
    StatsDProvider,
    StrapiClient,
    UsageCountersManager,
    UsageGrantsManager,
    UsageRefillManager,
    UsageRefillRepository,
    UsageRefillService,
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(StatsDService) private readonly statsd: StatsD) {}

  onApplicationShutdown(): Promise<void> {
    return new Promise((resolve) => this.statsd.close(() => resolve()));
  }
}
