/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import { allOf, counter, initialize } from './utils/metrics';

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
    initialize(
      this.errors,
      allOf<ConsumerErrorStage>({
        confirm: true,
        dedupe: true,
        flush: true,
        insert: true,
        invalid: true,
        meter: true,
        subscription: true,
      }).map((stage) => ({ stage }))
    );
  }
}
