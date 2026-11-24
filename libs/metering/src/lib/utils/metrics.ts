/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  Counter,
  Gauge,
  Histogram,
  type LabelValues,
  type Registry,
} from '@prometheus-io/client';

/** Buckets for job durations, up to the sweep's ~15 minute shutdown grace. */
const JOB_DURATION_BUCKETS = [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 900];

/** Lists every member of `T`; the `Record` fails to compile if one is missing. */
export const allOf = <T extends string>(members: Record<T, true>): T[] =>
  Object.keys(members) as T[];

/**
 * Starts each label combination at 0. A series that first appears at 1 hides
 * that increment from `increase()` and `rate()`, so rare events read as none.
 */
export const initialize = <L extends string>(
  metric: Counter<L>,
  combinations: LabelValues<L>[]
): void => {
  for (const labels of combinations) {
    metric.inc(labels, 0);
  }
};

export const counter = <L extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: readonly L[] = []
) => new Counter<L>({ name, help, labelNames, registers: [registry] });

export const gauge = <L extends string>(
  registry: Registry,
  name: string,
  help: string,
  labelNames: readonly L[] = []
) => new Gauge<L>({ name, help, labelNames, registers: [registry] });

export const jobHistogram = <L extends string>(
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
