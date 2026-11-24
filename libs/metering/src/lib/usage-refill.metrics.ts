/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import type { UsageRefillOutcome } from './usage-refill.service';
import {
  allOf,
  counter,
  gauge,
  initialize,
  jobHistogram,
} from './utils/metrics';

@Injectable()
export class RefillMetrics {
  readonly refills;
  readonly duration;
  readonly meterErrors;
  readonly counters;
  readonly sessions;
  readonly dedupeKeys;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.refills = counter(
      registry,
      'metering_refill_total',
      'Usage counter refills',
      ['outcome']
    );
    initialize(
      this.refills,
      allOf<UsageRefillOutcome>({
        refilled: true,
        repaired: true,
        'meters-rebuilt': true,
        checked: true,
      }).map((outcome) => ({ outcome }))
    );
    this.duration = jobHistogram(
      registry,
      'metering_refill_duration_seconds',
      'Duration of a usage counter refill',
      ['outcome']
    );
    this.meterErrors = counter(
      registry,
      'metering_refill_meter_errors_total',
      'Meters the refill failed to load',
      ['slug']
    );
    this.counters = gauge(
      registry,
      'metering_refill_counters',
      'Usage counters written by the last refill'
    );
    this.sessions = gauge(
      registry,
      'metering_refill_sessions',
      'Sessions written by the last refill'
    );
    this.dedupeKeys = gauge(
      registry,
      'metering_refill_dedupe_keys',
      'Dedupe keys written by the last refill'
    );
  }

  resetGauges(): void {
    this.counters.reset();
    this.sessions.reset();
    this.dedupeKeys.reset();
  }
}
