import {
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RootConfigModule } from '../config/config.module';
import {
  ClickHouseClient,
  ClickHouseRateLimitersProvider,
  MeteringAuthGuard,
  MeteringEventsManager,
  MeteringEventsRepository,
  MeteringExceptionFilter,
  MeteringFirestoreProvider,
  MeteringPubSubClientProvider,
  MeteringPublisherManager,
  MeteringSweepManager,
  MeteringSweepRepository,
  UsageController,
  UsageGrantsController,
  UsageGrantsManager,
  UsageGrantsService,
  UsageService,
} from '@entitlements/metering';
import {
  MeteringConfigurationManager,
  StrapiClient,
} from '@entitlements/shared/cms';
import { FirestoreProvider } from '@entitlements/shared/db/firestore';
import {
  StatsDProvider,
  StatsDRouteMiddleware,
} from '@entitlements/shared/metrics/statsd';

@Module({
  imports: [SentryModule.forRoot(), RootConfigModule],
  controllers: [AppController, UsageController, UsageGrantsController],
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
    MeteringAuthGuard,
    MeteringConfigurationManager,
    MeteringEventsManager,
    MeteringEventsRepository,
    MeteringExceptionFilter,
    MeteringFirestoreProvider,
    MeteringPubSubClientProvider,
    MeteringPublisherManager,
    MeteringSweepManager,
    MeteringSweepRepository,
    StatsDProvider,
    StrapiClient,
    UsageGrantsManager,
    UsageGrantsService,
    UsageService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(StatsDRouteMiddleware)
      .exclude(
        { path: '__heartbeat__', method: RequestMethod.GET },
        { path: '__lbheartbeat__', method: RequestMethod.GET },
        { path: '__version__', method: RequestMethod.GET }
      )
      .forRoutes('*');
  }
}
