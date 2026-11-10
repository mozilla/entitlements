/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Provider } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class MeteringUsageCountersConfig {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly refillTimeoutSeconds: number = 900;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  public readonly ingestPauseSettleMs: number = 20_000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly ingestPauseTtlSeconds: number = 3600;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  public readonly repairMarginMs: number = 300_000;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly refillBatchSize: number = 5_000;
}

export const MockMeteringUsageCountersConfig = {
  refillTimeoutSeconds: 900,
  ingestPauseSettleMs: 0,
  ingestPauseTtlSeconds: 3600,
  repairMarginMs: 300_000,
  refillBatchSize: 2,
} satisfies MeteringUsageCountersConfig;

export const MockMeteringUsageCountersConfigProvider = {
  provide: MeteringUsageCountersConfig,
  useValue: MockMeteringUsageCountersConfig,
} satisfies Provider<MeteringUsageCountersConfig>;
