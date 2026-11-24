/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import { counter, gauge, jobHistogram } from './utils/metrics';

@Injectable()
export class MetricsReportMetrics {
  readonly reports;
  readonly duration;
  readonly allDuration;
  readonly meterLimit;
  readonly activeSubjectsToday;
  readonly notifiedSubjects;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.reports = counter(
      registry,
      'metering_metrics_report_total',
      'Meter metrics reports',
      ['outcome', 'slug']
    );
    this.duration = jobHistogram(
      registry,
      'metering_metrics_report_duration_seconds',
      'Duration of one meter metrics report',
      ['slug']
    );
    this.allDuration = jobHistogram(
      registry,
      'metering_metrics_report_all_duration_seconds',
      'Duration of a metrics report over every meter'
    );
    this.meterLimit = gauge(
      registry,
      'metering_meter_limit',
      'Configured meter limit',
      ['client_id', 'slug', 'unit']
    );
    this.activeSubjectsToday = gauge(
      registry,
      'metering_active_subjects_today',
      'Subjects with usage today',
      ['client_id', 'slug']
    );
    this.notifiedSubjects = gauge(
      registry,
      'metering_notified_subjects',
      'Subjects notified for a threshold in the current window',
      ['client_id', 'slug', 'threshold']
    );
  }

  resetGauges(): void {
    this.meterLimit.reset();
    this.activeSubjectsToday.reset();
    this.notifiedSubjects.reset();
  }
}
