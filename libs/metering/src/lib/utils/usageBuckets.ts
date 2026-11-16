/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DAY_MS, HOUR_MS } from '../metering.constants';
import type { CounterRead, MeterSubjectKey } from '../metering.types';
import { dayCountersKey, hourCountersKey } from './redisKeys';

export interface UsageBuckets {
  days: Date[];
  hours: Date[];
}

export function monthOf(time: Date): string {
  return time.toISOString().slice(0, 7);
}

export function dayOf(time: Date): string {
  return time.toISOString().slice(0, 10);
}

export function dayField(time: Date): string {
  return `d${time.getUTCDate()}`;
}

export function hourField(time: Date): string {
  return `h${time.getUTCHours()}`;
}

export function startOfUtcDay(time: Date): Date {
  return new Date(Math.floor(time.getTime() / DAY_MS) * DAY_MS);
}

export function startOfNextUtcMonth(time: Date): Date {
  return new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth() + 1, 1));
}

function hourStarts(fromMs: number, toMs: number): Date[] {
  const hours: Date[] = [];
  for (let hourMs = fromMs; hourMs < toMs; hourMs += HOUR_MS) {
    hours.push(new Date(hourMs));
  }
  return hours;
}

export function splitIntoBuckets(from: Date, to: Date): UsageBuckets {
  const fromMs = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS;
  const toMs = Math.ceil(to.getTime() / HOUR_MS) * HOUR_MS;
  const firstWholeDayMs = Math.ceil(fromMs / DAY_MS) * DAY_MS;
  const lastWholeDayEndMs = Math.floor(toMs / DAY_MS) * DAY_MS;

  if (firstWholeDayMs >= lastWholeDayEndMs) {
    return { days: [], hours: hourStarts(fromMs, toMs) };
  }

  const days: Date[] = [];
  for (
    let dayMs = firstWholeDayMs;
    dayMs < lastWholeDayEndMs;
    dayMs += DAY_MS
  ) {
    days.push(new Date(dayMs));
  }
  return {
    days,
    hours: [
      ...hourStarts(fromMs, firstWholeDayMs),
      ...hourStarts(lastWholeDayEndMs, toMs),
    ],
  };
}

export function counterReadsForBuckets(
  key: MeterSubjectKey,
  buckets: UsageBuckets
): CounterRead[] {
  const reads = new Map<string, string[]>();
  const addField = (redisKey: string, field: string) => {
    const fields = reads.get(redisKey) ?? [];
    fields.push(field);
    reads.set(redisKey, fields);
  };

  for (const day of buckets.days) {
    addField(dayCountersKey(key, monthOf(day)), dayField(day));
  }
  for (const hour of buckets.hours) {
    addField(hourCountersKey(key, dayOf(hour)), hourField(hour));
  }

  return Array.from(reads, ([redisKey, fields]) => ({ key: redisKey, fields }));
}
