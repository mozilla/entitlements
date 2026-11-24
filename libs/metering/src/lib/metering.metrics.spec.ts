/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Registry } from '@prometheus-io/client';

import {
  ClickHouseMetrics,
  ConsumerMetrics,
  RefillMetrics,
  SchedulerMetrics,
  UsageGrantsMetrics,
  UsageMetrics,
  WebhookMetrics,
} from './metering.metrics';
import { metricValues } from '../testing';

const atZero = (labels: Record<string, string>[]) =>
  labels.map((label) => ({ value: 0, labels: label }));

describe('metering metrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('starts each refill outcome at zero', async () => {
    new RefillMetrics(registry);

    expect(await metricValues(registry, 'metering_refill_total')).toEqual(
      atZero([
        { outcome: 'refilled' },
        { outcome: 'repaired' },
        { outcome: 'meters-rebuilt' },
        { outcome: 'checked' },
      ])
    );
  });

  it('starts each consumer error stage at zero', async () => {
    new ConsumerMetrics(registry);

    expect(
      await metricValues(registry, 'metering_consumer_errors_total')
    ).toEqual(
      atZero(
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

  it('starts each usage source at zero', async () => {
    new UsageMetrics(registry);

    expect(await metricValues(registry, 'metering_usage_source_total')).toEqual(
      atZero([
        { source: 'redis' },
        { source: 'clickhouse-not-populated' },
        { source: 'clickhouse-redis-error' },
      ])
    );
  });

  it('starts each usage grant cache operation at zero', async () => {
    new UsageGrantsMetrics(registry);

    expect(
      await metricValues(registry, 'metering_usage_grants_cache_errors_total')
    ).toEqual(
      atZero([
        { operation: 'read' },
        { operation: 'write' },
        { operation: 'clear' },
      ])
    );
  });

  it.each([
    'metering_clickhouse_limit_rejected_total',
    'metering_clickhouse_limiter_errors_total',
  ])('starts %s at zero for each operation and its budgets', async (name) => {
    new ClickHouseMetrics(registry);

    expect(await metricValues(registry, name)).toEqual(
      atZero([
        { operation: 'query', budget: 'read' },
        { operation: 'query', budget: 'usageFallback' },
        { operation: 'stream', budget: 'read' },
        { operation: 'stream', budget: 'usageFallback' },
        { operation: 'insert', budget: 'write' },
        { operation: 'command', budget: 'write' },
      ])
    );
  });

  describe('SchedulerMetrics.initializeJob', () => {
    beforeEach(() => {
      new SchedulerMetrics(registry).initializeJob('sweep');
    });

    it('starts each run outcome of the job at zero', async () => {
      expect(
        await metricValues(registry, 'metering_scheduler_runs_total')
      ).toEqual(
        atZero([
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
        atZero([
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
        atZero([
          { key: 'sweep:owner', detected_by: 'renewal' },
          { key: 'sweep:owner', detected_by: 'deadline' },
          { key: 'sweep', detected_by: 'renewal' },
          { key: 'sweep', detected_by: 'deadline' },
        ])
      );
    });
  });

  it('starts dispatch errors at zero for each initialized signing client', async () => {
    new WebhookMetrics(registry).initializeClients(['vpn', 'relay']);

    expect(
      await metricValues(registry, 'metering_webhook_dispatch_errors_total')
    ).toEqual(
      atZero([{ signing_client_id: 'vpn' }, { signing_client_id: 'relay' }])
    );
  });
});
