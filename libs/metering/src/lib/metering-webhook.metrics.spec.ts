/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Registry } from '@prometheus-io/client';

import { WebhookMetrics } from './metering-webhook.metrics';
import { metricValues, zeroMetricValues } from '../testing';

describe('WebhookMetrics', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  describe('initializeClients', () => {
    it('starts dispatch errors at zero for each signing client', async () => {
      new WebhookMetrics(registry).initializeClients(['vpn', 'relay']);

      expect(
        await metricValues(registry, 'metering_webhook_dispatch_errors_total')
      ).toEqual(
        zeroMetricValues([
          { signing_client_id: 'vpn' },
          { signing_client_id: 'relay' },
        ])
      );
    });
  });
});
