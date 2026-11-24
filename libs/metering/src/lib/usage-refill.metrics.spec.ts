/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Registry } from '@prometheus-io/client';

import { RefillMetrics } from './usage-refill.metrics';
import { metricValues, zeroMetricValues } from '../testing';

describe('RefillMetrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('starts each refill outcome at zero', async () => {
    new RefillMetrics(registry);

    expect(await metricValues(registry, 'metering_refill_total')).toEqual(
      zeroMetricValues([
        { outcome: 'refilled' },
        { outcome: 'repaired' },
        { outcome: 'meters-rebuilt' },
        { outcome: 'checked' },
      ])
    );
  });
});
