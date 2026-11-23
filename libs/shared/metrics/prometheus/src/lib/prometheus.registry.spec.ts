/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { FactoryProvider } from '@nestjs/common';
import type { Registry } from 'prom-client';

import { PrometheusRegistryProvider } from './prometheus.registry';

describe('PrometheusRegistryProvider', () => {
  const create = () =>
    (
      PrometheusRegistryProvider as FactoryProvider<Registry>
    ).useFactory() as Registry;

  it('collects the default process metrics', async () => {
    expect(await create().metrics()).toContain('process_cpu_seconds_total');
  });

  it('creates a separate registry each time', () => {
    expect(create()).not.toBe(create());
  });
});
