/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import type { ClickHouseReadBudget } from './clickhouse.client';
import { allOf, counter, initialize } from './utils/metrics';

@Injectable()
export class ClickHouseMetrics {
  readonly limitRejected;
  readonly limiterErrors;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.limitRejected = counter(
      registry,
      'metering_clickhouse_limit_rejected_total',
      'ClickHouse operations rejected by the rate limiter',
      ['operation', 'budget']
    );
    this.limiterErrors = counter(
      registry,
      'metering_clickhouse_limiter_errors_total',
      'ClickHouse rate limiter failures',
      ['operation', 'budget']
    );
    const readBudgets = allOf<ClickHouseReadBudget>({
      read: true,
      usageFallback: true,
    });
    const operations = [
      ...['query', 'stream'].flatMap((operation) =>
        readBudgets.map((budget) => ({ operation, budget }))
      ),
      { operation: 'insert', budget: 'write' },
      { operation: 'command', budget: 'write' },
    ];
    initialize(this.limitRejected, operations);
    initialize(this.limiterErrors, operations);
  }
}
