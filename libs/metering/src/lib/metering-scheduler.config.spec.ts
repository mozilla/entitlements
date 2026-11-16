/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'reflect-metadata';

import { CronExpression } from '@nestjs/schedule';
import { plainToClass } from 'class-transformer';
import { validateSync } from 'class-validator';

import { MeteringSchedulerConfig } from './metering-scheduler.config';

function validateConfig(raw: Record<string, unknown>) {
  const config = plainToClass(MeteringSchedulerConfig, raw, {
    exposeDefaultValues: true,
  });
  const errors = validateSync(config, {
    forbidUnknownValues: true,
    whitelist: true,
  });
  return { config, errors };
}

describe('MeteringSchedulerConfig', () => {
  it('sweeps every minute by default', () => {
    expect(validateConfig({}).config.sweepCron).toBe(
      CronExpression.EVERY_MINUTE
    );
  });

  it('reports metrics every 5 minutes by default', () => {
    expect(validateConfig({}).config.metricsCron).toBe(
      CronExpression.EVERY_5_MINUTES
    );
  });

  it('accepts the defaults', () => {
    expect(validateConfig({}).errors).toEqual([]);
  });

  it('accepts configured cron expressions', () => {
    const { config, errors } = validateConfig({
      sweepCron: '*/2 * * * *',
      metricsCron: '0 * * * *',
    });

    expect({ errors, sweepCron: config.sweepCron, metricsCron: config.metricsCron }).toEqual({
      errors: [],
      sweepCron: '*/2 * * * *',
      metricsCron: '0 * * * *',
    });
  });

  it.each([
    { property: 'sweepCron', value: 'every minute' },
    { property: 'metricsCron', value: '61 * * * *' },
    { property: 'sweepCron', value: '' },
  ])('rejects $property "$value"', ({ property, value }) => {
    const { errors } = validateConfig({ [property]: value });

    expect(errors.map((error) => error.constraints)).toEqual([
      { isCronExpression: `${property} must be a valid cron expression` },
    ]);
  });
});
