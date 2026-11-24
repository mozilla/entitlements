/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Provider } from '@nestjs/common';
import { Registry, collectDefaultMetrics } from '@prometheus-io/client';

export const PrometheusRegistry = Symbol('PROMETHEUS_REGISTRY');

export const PrometheusRegistryProvider: Provider<Registry> = {
  provide: PrometheusRegistry,
  useFactory: () => {
    const registry = new Registry();
    collectDefaultMetrics({ register: registry });
    return registry;
  },
};
