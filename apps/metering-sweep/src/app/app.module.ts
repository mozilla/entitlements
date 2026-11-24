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
  ClickHouseMetrics,
  ClickHouseRateLimitersProvider,
  MeteringFirestoreProvider,
  MeteringLockRedisClientProvider,
  MeteringRedisClientProvider,
  MeteringSchedulerService,
  MeteringSweepSchedulerService,
  MeteringSweepManager,
  MeteringSweepRepository,
  MeteringSweepService,
  MeteringWebhookManager,
  RefillMetrics,
  SchedulerMetrics,
  SweepMetrics,
  UsageCountersManager,
  UsageGrantsManager,
  UsageGrantsMetrics,
  UsageRefillManager,
  UsageRefillRepository,
  UsageRefillService,
  WebhookMetrics,
} from '@entitlements/metering';
import {
  MeteringConfigurationManager,
  StrapiClient,
} from '@entitlements/shared/cms';
import { FirestoreProvider } from '@entitlements/shared/db/firestore';
import { RedisLockStore } from '@entitlements/shared/locks';
import {
  PrometheusRegistryProvider,
  PrometheusServer,
} from '@entitlements/shared/metrics/prometheus';
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
    RedisLockStore,
    MeteringRedisClientProvider,
    MeteringSchedulerService,
    MeteringSweepSchedulerService,
    MeteringSweepManager,
    MeteringSweepRepository,
    MeteringSweepService,
    MeteringWebhookManager,
    ClickHouseMetrics,
    RefillMetrics,
    SchedulerMetrics,
    SweepMetrics,
    UsageGrantsMetrics,
    WebhookMetrics,
    PrometheusRegistryProvider,
    PrometheusServer,
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
