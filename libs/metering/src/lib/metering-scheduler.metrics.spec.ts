/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Registry } from '@prometheus-io/client';

import { SchedulerMetrics } from './metering-scheduler.metrics';
import { metricValues, zeroMetricValues } from '../testing';

describe('SchedulerMetrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  describe('initializeJob', () => {
    beforeEach(() => {
      new SchedulerMetrics(registry).initializeJob('sweep');
    });

    it('starts each run outcome of the job at zero', async () => {
      expect(
        await metricValues(registry, 'metering_scheduler_runs_total')
      ).toEqual(
        zeroMetricValues([
          { job: 'sweep', outcome: 'ok' },
          { job: 'sweep', outcome: 'failed' },
          { job: 'sweep', outcome: 'error' },
        ])
      );
    });

    it('starts each skip reason of the job at zero', async () => {
      expect(
        await metricValues(registry, 'metering_scheduler_skips_total')
      ).toEqual(
        zeroMetricValues([
          { job: 'sweep', reason: 'ownership-unavailable' },
          { job: 'sweep', reason: 'run-lock-unavailable' },
          { job: 'sweep', reason: 'shutdown' },
        ])
      );
    });

    it('starts lost locks of the job ownership and run locks at zero', async () => {
      expect(
        await metricValues(registry, 'metering_scheduler_lock_lost_total')
      ).toEqual(
        zeroMetricValues([
          { key: 'sweep:owner', detected_by: 'renewal' },
          { key: 'sweep:owner', detected_by: 'deadline' },
          { key: 'sweep', detected_by: 'renewal' },
          { key: 'sweep', detected_by: 'deadline' },
        ])
      );
    });
  });
});
