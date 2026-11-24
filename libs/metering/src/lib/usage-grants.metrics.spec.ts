/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Registry } from '@prometheus-io/client';

import { UsageGrantsMetrics } from './usage-grants.metrics';
import { metricValues, zeroMetricValues } from '../testing';

describe('UsageGrantsMetrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('starts each usage grant cache operation at zero', async () => {
    new UsageGrantsMetrics(registry);

    expect(
      await metricValues(registry, 'metering_usage_grants_cache_errors_total')
    ).toEqual(
      zeroMetricValues([
        { operation: 'read' },
        { operation: 'write' },
        { operation: 'clear' },
      ])
    );
  });
});
