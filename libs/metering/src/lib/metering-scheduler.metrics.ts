/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import type { LocksJobSkipReason, LocksLockLostEvent } from '@nestjs/locks';
import type { Registry } from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import type { SchedulerJob, SchedulerRunOutcome } from './metering.types';
import { allOf, counter, initialize } from './utils/metrics';

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

  initializeJob(job: SchedulerJob): void {
    initialize(
      this.runs,
      allOf<SchedulerRunOutcome | 'error'>({
        ok: true,
        failed: true,
        error: true,
      }).map((outcome) => ({ job, outcome }))
    );
    initialize(
      this.skips,
      allOf<LocksJobSkipReason>({
        'ownership-unavailable': true,
        'run-lock-unavailable': true,
        shutdown: true,
      }).map((reason) => ({ job, reason }))
    );
    initialize(
      this.lockLost,
      [`${job}:owner`, job].flatMap((key) =>
        allOf<LocksLockLostEvent['detectedBy']>({
          renewal: true,
          deadline: true,
        }).map((detected_by) => ({ key, detected_by }))
      )
    );
  }
}
