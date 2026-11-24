/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  type Registry,
} from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

/** Buckets for job durations, up to the sweep's ~15 minute shutdown grace. */
const JOB_DURATION_BUCKETS = [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 900];

const counter = <L extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: readonly L[] = []
) => new Counter<L>({ name, help, labelNames, registers: [registry] });

const gauge = <L extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: readonly L[] = []
) => new Gauge<L>({ name, help, labelNames, registers: [registry] });

const jobHistogram = <L extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: readonly L[] = []
) =>
  new Histogram<L>({
    name,
    help,
    labelNames,
    buckets: JOB_DURATION_BUCKETS,
    registers: [registry],
  });

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

@Injectable()
export class SchedulerMetrics {
  readonly runs;
  readonly skips;
  readonly lockLost;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.runs = counter(
      registry,
      'metering_scheduler_runs_total',
      'Scheduled job runs',
      ['job', 'outcome']
    );
    this.skips = counter(
      registry,
      'metering_scheduler_skips_total',
      'Scheduled job ticks skipped',
      ['job', 'reason']
    );
    this.lockLost = counter(
      registry,
      'metering_scheduler_lock_lost_total',
      'Scheduler locks lost while held',
      ['key', 'detected_by']
    );
  }
}

export type ConsumerErrorStage =
  | 'confirm'
  | 'dedupe'
  | 'flush'
  | 'insert'
  | 'invalid'
  | 'meter'
  | 'subscription';

@Injectable()
export class ConsumerMetrics {
  readonly received;
  readonly paused;
  readonly pending;
  readonly duplicates;
  readonly inserted;
  readonly insertedAmount;
  readonly errors;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.received = counter(
      registry,
      'metering_consumer_received_total',
      'Pub/Sub messages received'
    );
    this.paused = counter(
      registry,
      'metering_consumer_paused_total',
      'Messages nacked while ingest is paused'
    );
    this.pending = counter(
      registry,
      'metering_consumer_pending_total',
      'Messages nacked while their dedupe key is pending elsewhere'
    );
    this.duplicates = counter(
      registry,
      'metering_consumer_duplicate_total',
      'Duplicate messages acked without inserting'
    );
    this.inserted = counter(
      registry,
      'metering_consumer_inserted_total',
      'Events inserted into ClickHouse',
      ['client_id', 'slug']
    );
    this.insertedAmount = counter(
      registry,
      'metering_consumer_inserted_amount_total',
      'Usage amount inserted into ClickHouse',
      ['client_id', 'slug']
    );
    this.errors = counter<'stage'>(
      registry,
      'metering_consumer_errors_total',
      'Consumer failures by stage',
      ['stage']
    );
  }
}

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

@Injectable()
export class UsageGrantsMetrics {
  readonly cacheErrors;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.cacheErrors = counter(
      registry,
      'metering_usage_grants_cache_errors_total',
      'Usage grant cache failures',
      ['operation']
    );
  }
}

@Injectable()
export class WebhookMetrics {
  readonly dispatches;
  readonly dispatchErrors;
  readonly noSecret;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.dispatches = counter(
      registry,
      'metering_webhook_dispatch_total',
      'Webhook dispatches by response status class',
      ['signing_client_id', 'status']
    );
    this.dispatchErrors = counter(
      registry,
      'metering_webhook_dispatch_errors_total',
      'Webhook dispatches with a non-2xx response',
      ['signing_client_id']
    );
    this.noSecret = counter(
      registry,
      'metering_webhook_no_secret_total',
      'Webhook dispatches skipped for a missing signing secret',
      ['signing_client_id']
    );
  }
}

@Injectable()
export class ClickHouseMetrics {
  readonly limitRejected;
  readonly limiterErrors;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.limitRejected = counter(
      registry,
      'metering_clickhouse_limit_rejected_total',
      'ClickHouse operations rejected by the rate limiter',
      ['operation', 'budget']
    );
    this.limiterErrors = counter(
      registry,
      'metering_clickhouse_limiter_errors_total',
      'ClickHouse rate limiter failures',
      ['operation', 'budget']
    );
  }
}
