/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import { counter, gauge, jobHistogram } from './utils/metrics';

@Injectable()
export class SweepMetrics {
  readonly sweeps;
  readonly duration;
  readonly allDuration;
  readonly watermarkAge;
  readonly watermarkHeld;
  readonly sessionsOpened;
  readonly sessionsCorrected;
  readonly dispatched;
  readonly subjectErrors;
  readonly dispatchErrors;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.sweeps = counter(registry, 'metering_sweep_total', 'Meter sweeps', [
      'outcome',
      'slug',
    ]);
    this.duration = jobHistogram(
      registry,
      'metering_sweep_duration_seconds',
      'Duration of one meter sweep',
      ['slug']
    );
    this.allDuration = jobHistogram(
      registry,
      'metering_sweep_all_duration_seconds',
      'Duration of a sweep over every meter'
    );
    this.watermarkAge = gauge(
      registry,
      'metering_sweep_watermark_age_seconds',
      'Age of the sweep watermark when a meter sweep starts',
      ['slug']
    );
    this.watermarkHeld = counter(
      registry,
      'metering_sweep_watermark_held_total',
      'Meter sweeps that held the watermark back',
      ['slug']
    );
    this.sessionsOpened = counter(
      registry,
      'metering_sweep_sessions_opened_total',
      'Sessions opened by the sweep',
      ['slug']
    );
    this.sessionsCorrected = counter(
      registry,
      'metering_sweep_sessions_corrected_total',
      'Counted sessions corrected by the sweep',
      ['slug']
    );
    this.dispatched = counter(
      registry,
      'metering_sweep_dispatched_total',
      'Threshold notifications dispatched and recorded',
      ['client_id', 'slug', 'threshold']
    );
    this.subjectErrors = counter(
      registry,
      'metering_sweep_subject_errors_total',
      'Subjects the sweep failed to process'
    );
    this.dispatchErrors = counter(
      registry,
      'metering_sweep_dispatch_errors_total',
      'Threshold notifications that failed to dispatch'
    );
  }

  resetGauges(): void {
    this.watermarkAge.reset();
  }
}
