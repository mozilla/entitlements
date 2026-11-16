import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsOptional, ValidateNested } from 'class-validator';
import type { LogLevel } from '@nestjs/common';

import { MeteringConfig } from '@entitlements/metering';
import { StrapiClientConfig } from '@entitlements/shared/cms';
import { FirestoreConfig } from '@entitlements/shared/db/firestore';
import { StatsDConfig } from '@entitlements/shared/metrics/statsd';
import { SentryConfig } from './sentry.config';

export const NEST_LOG_LEVELS: Record<string, LogLevel> = {
  verbose: 'verbose',
  debug: 'debug',
  info: 'log',
  log: 'log',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

export class RootConfig {
  @Type(() => FirestoreConfig)
  @ValidateNested()
  @IsDefined()
  public readonly firestoreConfig!: Partial<FirestoreConfig>;

  @Type(() => StatsDConfig)
  @ValidateNested()
  @IsDefined()
  public readonly statsDConfig!: Partial<StatsDConfig>;

  @Type(() => SentryConfig)
  @ValidateNested()
  @IsDefined()
  public readonly sentryConfig!: Partial<SentryConfig>;

  @Type(() => StrapiClientConfig)
  @ValidateNested()
  @IsDefined()
  public readonly strapiClientConfig!: Partial<StrapiClientConfig>;

  @Type(() => MeteringConfig)
  @ValidateNested()
  @IsDefined()
  public readonly meteringConfig!: Partial<MeteringConfig>;

  @IsOptional()
  @IsIn(Object.keys(NEST_LOG_LEVELS))
  public readonly logLevel?: string;
}
