/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Logger, Module } from '@nestjs/common';
import { SentryModule } from '@sentry/nestjs/setup';

import {
  ClickHouseClient,
  MeteringFirestoreProvider,
  MeteringSweepManager,
  MeteringSweepRepository,
  MeteringSweepService,
  MeteringWebhookManager,
  UsageGrantsManager,
} from '@entitlements/metering';
import {
  MeteringConfigurationManager,
  StrapiClient,
} from '@entitlements/shared/cms';
import { FirestoreProvider } from '@entitlements/shared/db/firestore';
import { StatsDProvider } from '@entitlements/shared/metrics/statsd';

import { RootConfigModule } from '../config/config.module';

@Module({
  imports: [SentryModule.forRoot(), RootConfigModule],
  providers: [
    Logger,
    ClickHouseClient,
    FirestoreProvider,
    MeteringConfigurationManager,
    MeteringFirestoreProvider,
    MeteringSweepManager,
    MeteringSweepRepository,
    MeteringSweepService,
    MeteringWebhookManager,
    StatsDProvider,
    StrapiClient,
    UsageGrantsManager,
  ],
})
export class AppModule {}
