/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import { allOf, counter, initialize } from './utils/metrics';

export type UsageGrantsCacheOperation = 'read' | 'write' | 'clear';

@Injectable()
export class UsageGrantsMetrics {
  readonly cacheErrors;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.cacheErrors = counter(
      registry,
      'metering_usage_grants_cache_errors_total',
      'Usage grant cache failures',
      ['operation']
    );
    initialize(
      this.cacheErrors,
      allOf<UsageGrantsCacheOperation>({
        read: true,
        write: true,
        clear: true,
      }).map((operation) => ({ operation }))
    );
  }
}
