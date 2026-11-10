import { Logger, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RootConfigModule } from '../config/config.module';
import {
  ClickHouseClient,
  ClickHouseRateLimitersProvider,
  MeteringConsumerService,
  MeteringEventsManager,
  MeteringEventsRepository,
  MeteringPubSubClientProvider,
  MeteringRedisClientProvider,
  UsageCountersManager,
} from '@entitlements/metering';
import {
  MeteringConfigurationManager,
  StrapiClient,
} from '@entitlements/shared/cms';
import { FirestoreProvider } from '@entitlements/shared/db/firestore';
import { StatsDProvider } from '@entitlements/shared/metrics/statsd';

@Module({
  imports: [SentryModule.forRoot(), RootConfigModule],
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
    MeteringConsumerService,
    MeteringEventsManager,
    MeteringEventsRepository,
    MeteringPubSubClientProvider,
    MeteringRedisClientProvider,
    StatsDProvider,
    StrapiClient,
    UsageCountersManager,
  ],
})
export class AppModule {}
