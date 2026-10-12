// Must be the first import so Sentry patches Nest before it boots.
import './monitoring';

import { Logger } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import { ResponseValidationInterceptor } from '@entitlements/shared/api-server';
import { AppModule } from './app/app.module';
import { NEST_LOG_LEVELS, RootConfig } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: [NEST_LOG_LEVELS[process.env.LOG_LEVEL ?? ''] ?? 'log'],
  });

  app.use(
    helmet({
      hsts: { maxAge: 31536000, includeSubDomains: true },
    })
  );

  const config = app.get(RootConfig);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Entitlements API')
    .setDescription('API for metering usage and usage grants')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);

  // Swagger UI off by default; opt-in for local dev. Shows full unfiltered spec.
  if (config.swaggerUi) {
    SwaggerModule.setup('api-docs', app, document, {
      jsonDocumentUrl: 'swagger.json',
    });
  }

  // SECURITY: /swagger.json is intentionally unauthenticated (Backstage
  // depends on it).
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/swagger.json', (_req: Request, res: Response) => {
    res.json(document);
  });

  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(new ResponseValidationInterceptor(reflector));

  const port = process.env.PORT || 3037;
  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://localhost:${port}`);
}

bootstrap();
