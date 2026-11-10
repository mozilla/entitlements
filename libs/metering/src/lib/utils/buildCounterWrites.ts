/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MeteringWindow } from '@entitlements/shared/cms';

import type {
  CountedEvent,
  CounterExpiry,
  CounterIncrement,
  CounterWrites,
  SessionEventWrite,
} from '../metering.types';
import { dayCountersExpireAt, hourCountersExpireAt } from './counterExpiry';
import { dayCountersKey, hourCountersKey, sessionKey } from './redisKeys';
import { dayField, dayOf, hourField, monthOf } from './usageBuckets';

export function buildCounterWrites(
  events: CountedEvent[],
  windowsBySlug: Map<string, MeteringWindow>
): CounterWrites {
  const increments = new Map<string, CounterIncrement>();
  const expiries = new Map<string, CounterExpiry>();
  const sessionEvents: SessionEventWrite[] = [];

  const increment = (
    key: string,
    field: string,
    amount: number,
    expireAtSeconds: number
  ) => {
    const id = JSON.stringify([key, field]);
    const existing = increments.get(id);
    if (existing) {
      existing.amount += amount;
    } else {
      increments.set(id, { key, field, amount });
    }
    expiries.set(key, { key, expireAtSeconds });
  };

  for (const event of events) {
    const window = windowsBySlug.get(event.slug);
    if (!window) {
      continue;
    }

    if (window.kind === 'session') {
      sessionEvents.push({
        key: sessionKey(event),
        eventTimeMs: event.eventTime.getTime(),
        amount: event.amount,
        durationMs: window.durationMs,
      });
      continue;
    }

    increment(
      dayCountersKey(event, monthOf(event.eventTime)),
      dayField(event.eventTime),
      event.amount,
      dayCountersExpireAt(event.eventTime, window)
    );
    if (window.kind === 'sliding') {
      increment(
        hourCountersKey(event, dayOf(event.eventTime)),
        hourField(event.eventTime),
        event.amount,
        hourCountersExpireAt(event.eventTime, window.durationMs)
      );
    }
  }

  return {
    increments: Array.from(increments.values()),
    expiries: Array.from(expiries.values()),
    sessionEvents: sessionEvents.sort((a, b) => a.eventTimeMs - b.eventTimeMs),
  };
}
