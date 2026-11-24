/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class PrometheusConfig {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  public readonly port: number = 9464;
}
