/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Registry } from '@prometheus-io/client';

import { UsageMetrics } from './usage.metrics';
import { metricValues, zeroMetricValues } from '../testing';

describe('UsageMetrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('starts each usage source at zero', async () => {
    new UsageMetrics(registry);

    expect(await metricValues(registry, 'metering_usage_source_total')).toEqual(
      zeroMetricValues([
        { source: 'redis' },
        { source: 'clickhouse-not-populated' },
        { source: 'clickhouse-redis-error' },
      ])
    );
  });
});
