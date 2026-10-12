import { Logger, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RootConfigModule } from '../config/config.module';
import {
  ClickHouseClient,
  MeteringConsumerService,
  MeteringDedupeManager,
  MeteringDedupeRedisClientProvider,
  MeteringEventsManager,
  MeteringEventsRepository,
  MeteringPubSubClientProvider,
} from '@entitlements/metering';
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
    MeteringConsumerService,
    MeteringDedupeManager,
    MeteringDedupeRedisClientProvider,
    MeteringEventsManager,
    MeteringEventsRepository,
    MeteringPubSubClientProvider,
    StatsDProvider,
  ],
})
export class AppModule {}
