/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'reflect-metadata';

import { CronExpression } from '@nestjs/schedule';
import { plainToClass } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  MeteringMetricsSchedulerConfig,
  MeteringSweepSchedulerConfig,
} from './metering-scheduler.config';

const CONFIGS = [
  {
    name: 'MeteringSweepSchedulerConfig',
    Config: MeteringSweepSchedulerConfig,
    defaultCron: CronExpression.EVERY_MINUTE,
  },
  {
    name: 'MeteringMetricsSchedulerConfig',
    Config: MeteringMetricsSchedulerConfig,
    defaultCron: CronExpression.EVERY_5_MINUTES,
  },
];

function validateConfig(
  Config: (typeof CONFIGS)[number]['Config'],
  raw: Record<string, unknown>
) {
  const config = plainToClass(Config, raw, { exposeDefaultValues: true });
  const errors = validateSync(config, {
    forbidUnknownValues: true,
    whitelist: true,
  });
  return { config, errors };
}

describe.each(CONFIGS)('$name', ({ Config, defaultCron }) => {
  it(`defaults to "${defaultCron}"`, () => {
    expect(validateConfig(Config, {}).config.cron).toBe(defaultCron);
  });

  it('accepts the default', () => {
    expect(validateConfig(Config, {}).errors).toEqual([]);
  });

  it('uses a configured cron expression', () => {
    expect(validateConfig(Config, { cron: '*/2 * * * *' }).config.cron).toBe(
      '*/2 * * * *'
    );
  });

  it('accepts a configured cron expression', () => {
    expect(validateConfig(Config, { cron: '*/2 * * * *' }).errors).toEqual([]);
  });

  it.each(['every minute', '61 * * * *', ''])('rejects "%s"', (value) => {
    const { errors } = validateConfig(Config, { cron: value });

    expect(errors.map((error) => error.constraints)).toEqual([
      { isCronExpression: 'cron must be a valid cron expression' },
    ]);
  });
});
