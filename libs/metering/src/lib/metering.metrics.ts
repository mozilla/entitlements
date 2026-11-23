/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import type { SchedulerJob } from './metering.types';

/** Buckets for job durations, up to the sweep's ~15 minute shutdown grace. */
const JOB_DURATION_BUCKETS = [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 900];

export type ConsumerErrorStage =
  | 'confirm'
  | 'dedupe'
  | 'flush'
  | 'insert'
  | 'invalid'
  | 'meter'
  | 'subscription';

/**
 * Every Prometheus metric the metering lib emits, registered once per
 * registry. Gauges for scheduled jobs are reset when this instance stops
 * owning the job, so only the owning pod reports them.
 */
@Injectable()
export class MeteringMetrics {
  readonly sweeps;
  readonly sweepDuration;
  readonly sweepAllDuration;
  readonly sweepWatermarkAge;
  readonly sweepWatermarkHeld;
  readonly sweepSessionsOpened;
  readonly sweepSessionsCorrected;
  readonly sweepDispatched;
  readonly sweepSubjectErrors;
  readonly sweepDispatchErrors;

  readonly metricsReports;
  readonly metricsReportDuration;
  readonly metricsReportAllDuration;
  readonly meterLimit;
  readonly activeSubjectsToday;
  readonly notifiedSubjects;

  readonly schedulerRuns;
  readonly schedulerSkips;
  readonly schedulerLockLost;

  readonly refills;
  readonly refillDuration;
  readonly refillMeterErrors;
  readonly refillCounters;
  readonly refillSessions;
  readonly refillDedupeKeys;

  readonly consumerReceived;
  readonly consumerPaused;
  readonly consumerPending;
  readonly consumerDuplicates;
  readonly consumerInserted;
  readonly consumerInsertedAmount;
  readonly consumerErrors;

  readonly publisherPublished;
  readonly publisherErrors;

  readonly webhookDispatches;
  readonly webhookDispatchErrors;
  readonly webhookNoSecret;

  readonly clickhouseLimitRejected;
  readonly clickhouseLimiterErrors;

  readonly usageSource;
  readonly usageGrantsCacheErrors;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    const registers = [registry];
    const counter = <L extends string>(
      name: string,
      help: string,
      labelNames: readonly L[] = []
    ) => new Counter<L>({ name, help, labelNames, registers });
    const gauge = <L extends string>(
      name: string,
      help: string,
      labelNames: readonly L[] = []
    ) => new Gauge<L>({ name, help, labelNames, registers });
    const jobHistogram = <L extends string>(
      name: string,
      help: string,
      labelNames: readonly L[] = []
    ) =>
      new Histogram<L>({
        name,
        help,
        labelNames,
        buckets: JOB_DURATION_BUCKETS,
        registers,
      });

    this.sweeps = counter('metering_sweep_total', 'Meter sweeps', [
      'outcome',
      'slug',
    ]);
    this.sweepDuration = jobHistogram(
      'metering_sweep_duration_seconds',
      'Duration of one meter sweep',
      ['slug']
    );
    this.sweepAllDuration = jobHistogram(
      'metering_sweep_all_duration_seconds',
      'Duration of a sweep over every meter'
    );
    this.sweepWatermarkAge = gauge(
      'metering_sweep_watermark_age_seconds',
      'Age of the sweep watermark when a meter sweep starts',
      ['slug']
    );
    this.sweepWatermarkHeld = counter(
      'metering_sweep_watermark_held_total',
      'Meter sweeps that held the watermark back',
      ['slug']
    );
    this.sweepSessionsOpened = counter(
      'metering_sweep_sessions_opened_total',
      'Sessions opened by the sweep',
      ['slug']
    );
    this.sweepSessionsCorrected = counter(
      'metering_sweep_sessions_corrected_total',
      'Counted sessions corrected by the sweep',
      ['slug']
    );
    this.sweepDispatched = counter(
      'metering_sweep_dispatched_total',
      'Threshold notifications dispatched and recorded',
      ['client_id', 'slug', 'threshold']
    );
    this.sweepSubjectErrors = counter(
      'metering_sweep_subject_errors_total',
      'Subjects the sweep failed to process'
    );
    this.sweepDispatchErrors = counter(
      'metering_sweep_dispatch_errors_total',
      'Threshold notifications that failed to dispatch'
    );

    this.metricsReports = counter(
      'metering_metrics_report_total',
      'Meter metrics reports',
      ['outcome', 'slug']
    );
    this.metricsReportDuration = jobHistogram(
      'metering_metrics_report_duration_seconds',
      'Duration of one meter metrics report',
      ['slug']
    );
    this.metricsReportAllDuration = jobHistogram(
      'metering_metrics_report_all_duration_seconds',
      'Duration of a metrics report over every meter'
    );
    this.meterLimit = gauge('metering_meter_limit', 'Configured meter limit', [
      'client_id',
      'slug',
      'unit',
    ]);
    this.activeSubjectsToday = gauge(
      'metering_active_subjects_today',
      'Subjects with usage today',
      ['client_id', 'slug']
    );
    this.notifiedSubjects = gauge(
      'metering_notified_subjects',
      'Subjects notified for a threshold in the current window',
      ['client_id', 'slug', 'threshold']
    );

    this.schedulerRuns = counter(
      'metering_scheduler_runs_total',
      'Scheduled job runs',
      ['job', 'outcome']
    );
    this.schedulerSkips = counter(
      'metering_scheduler_skips_total',
      'Scheduled job ticks skipped',
      ['job', 'reason']
    );
    this.schedulerLockLost = counter(
      'metering_scheduler_lock_lost_total',
      'Scheduler locks lost while held',
      ['key', 'detected_by']
    );

    this.refills = counter('metering_refill_total', 'Usage counter refills', [
      'outcome',
    ]);
    this.refillDuration = jobHistogram(
      'metering_refill_duration_seconds',
      'Duration of a usage counter refill',
      ['outcome']
    );
    this.refillMeterErrors = counter(
      'metering_refill_meter_errors_total',
      'Meters the refill failed to load',
      ['slug']
    );
    this.refillCounters = gauge(
      'metering_refill_counters',
      'Usage counters written by the last refill'
    );
    this.refillSessions = gauge(
      'metering_refill_sessions',
      'Sessions written by the last refill'
    );
    this.refillDedupeKeys = gauge(
      'metering_refill_dedupe_keys',
      'Dedupe keys written by the last refill'
    );

    this.consumerReceived = counter(
      'metering_consumer_received_total',
      'Pub/Sub messages received'
    );
    this.consumerPaused = counter(
      'metering_consumer_paused_total',
      'Messages nacked while ingest is paused'
    );
    this.consumerPending = counter(
      'metering_consumer_pending_total',
      'Messages nacked while their dedupe key is pending elsewhere'
    );
    this.consumerDuplicates = counter(
      'metering_consumer_duplicate_total',
      'Duplicate messages acked without inserting'
    );
    this.consumerInserted = counter(
      'metering_consumer_inserted_total',
      'Events inserted into ClickHouse',
      ['client_id', 'slug']
    );
    this.consumerInsertedAmount = counter(
      'metering_consumer_inserted_amount_total',
      'Usage amount inserted into ClickHouse',
      ['client_id', 'slug']
    );
    this.consumerErrors = counter(
      'metering_consumer_errors_total',
      'Consumer failures by stage',
      ['stage']
    );

    this.publisherPublished = counter(
      'metering_publisher_published_total',
      'Usage events published to Pub/Sub'
    );
    this.publisherErrors = counter(
      'metering_publisher_errors_total',
      'Usage events that failed to publish'
    );

    this.webhookDispatches = counter(
      'metering_webhook_dispatch_total',
      'Webhook dispatches by response status class',
      ['signing_client_id', 'status']
    );
    this.webhookDispatchErrors = counter(
      'metering_webhook_dispatch_errors_total',
      'Webhook dispatches with a non-2xx response',
      ['signing_client_id']
    );
    this.webhookNoSecret = counter(
      'metering_webhook_no_secret_total',
      'Webhook dispatches skipped for a missing signing secret',
      ['signing_client_id']
    );

    this.clickhouseLimitRejected = counter(
      'metering_clickhouse_limit_rejected_total',
      'ClickHouse operations rejected by the rate limiter',
      ['operation', 'budget']
    );
    this.clickhouseLimiterErrors = counter(
      'metering_clickhouse_limiter_errors_total',
      'ClickHouse rate limiter failures',
      ['operation', 'budget']
    );

    this.usageSource = counter(
      'metering_usage_source_total',
      'Window usage lookups by the source that answered',
      ['source']
    );
    this.usageGrantsCacheErrors = counter(
      'metering_usage_grants_cache_errors_total',
      'Usage grant cache failures',
      ['operation']
    );
  }

  resetJobGauges(job: SchedulerJob): void {
    const gauges =
      job === 'sweep'
        ? [
            this.sweepWatermarkAge,
            this.refillCounters,
            this.refillSessions,
            this.refillDedupeKeys,
          ]
        : [this.meterLimit, this.activeSubjectsToday, this.notifiedSubjects];
    for (const gauge of gauges) {
      gauge.reset();
    }
  }
}
