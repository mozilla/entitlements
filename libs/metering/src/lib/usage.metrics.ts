/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import { allOf, counter, initialize } from './utils/metrics';

export type UsageSource =
  'redis' | 'clickhouse-not-populated' | 'clickhouse-redis-error';

@Injectable()
export class UsageMetrics {
  readonly source;
  readonly published;
  readonly publishErrors;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.source = counter(
      registry,
      'metering_usage_source_total',
      'Window usage lookups by the source that answered',
      ['source']
    );
    initialize(
      this.source,
      allOf<UsageSource>({
        redis: true,
        'clickhouse-not-populated': true,
        'clickhouse-redis-error': true,
      }).map((source) => ({ source }))
    );
    this.published = counter(
      registry,
      'metering_publisher_published_total',
      'Usage events published to Pub/Sub'
    );
    this.publishErrors = counter(
      registry,
      'metering_publisher_errors_total',
      'Usage events that failed to publish'
    );
  }
}
