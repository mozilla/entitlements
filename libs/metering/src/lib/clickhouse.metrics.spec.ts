/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Registry } from '@prometheus-io/client';

import { ClickHouseMetrics } from './clickhouse.metrics';
import { metricValues, zeroMetricValues } from '../testing';

describe('ClickHouseMetrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it.each([
    'metering_clickhouse_limit_rejected_total',
    'metering_clickhouse_limiter_errors_total',
  ])('starts %s at zero for each operation and its budgets', async (name) => {
    new ClickHouseMetrics(registry);

    expect(await metricValues(registry, name)).toEqual(
      zeroMetricValues([
        { operation: 'query', budget: 'read' },
        { operation: 'query', budget: 'usageFallback' },
        { operation: 'stream', budget: 'read' },
        { operation: 'stream', budget: 'usageFallback' },
        { operation: 'insert', budget: 'write' },
        { operation: 'command', budget: 'write' },
      ])
    );
  });
});
