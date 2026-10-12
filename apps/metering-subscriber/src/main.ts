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

  const port = process.env.PORT || 3038;
  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://localhost:${port}`);
}

bootstrap();
