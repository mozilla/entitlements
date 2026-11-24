/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Registry } from '@prometheus-io/client';

import { ConsumerMetrics } from './metering-consumer.metrics';
import { metricValues, zeroMetricValues } from '../testing';

describe('ConsumerMetrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('starts each consumer error stage at zero', async () => {
    new ConsumerMetrics(registry);

    expect(
      await metricValues(registry, 'metering_consumer_errors_total')
    ).toEqual(
      zeroMetricValues(
        [
          'confirm',
          'dedupe',
          'flush',
          'insert',
          'invalid',
          'meter',
          'subscription',
        ].map((stage) => ({ stage }))
      )
    );
  });
});
