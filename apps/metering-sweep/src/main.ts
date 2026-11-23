/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Must be the first import so Sentry patches Nest before it boots.
import './monitoring';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { NEST_LOG_LEVELS } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: [NEST_LOG_LEVELS[process.env.LOG_LEVEL ?? ''] ?? 'log'],
  });

  const port = process.env.PORT || 3039;
  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://localhost:${port}`);
}

bootstrap();
