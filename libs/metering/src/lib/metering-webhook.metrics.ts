/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';

import { counter, initialize } from './utils/metrics';

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

  initializeClients(signingClientIds: string[]): void {
    initialize(
      this.dispatchErrors,
      signingClientIds.map((signing_client_id) => ({ signing_client_id }))
    );
  }
}
