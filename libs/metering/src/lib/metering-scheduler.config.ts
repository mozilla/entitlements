/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CronExpression } from '@nestjs/schedule';
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { validateCronExpression } from 'cron';

function IsCronExpression(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isCronExpression',
      target: target.constructor,
      propertyName: String(propertyName),
      options: {
        message: '$property must be a valid cron expression',
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && validateCronExpression(value).valid,
      },
    });
  };
}

export class MeteringSchedulerConfig {
  @IsCronExpression()
  public readonly sweepCron: string = CronExpression.EVERY_MINUTE;

  @IsCronExpression()
  public readonly metricsCron: string = CronExpression.EVERY_5_MINUTES;
}
