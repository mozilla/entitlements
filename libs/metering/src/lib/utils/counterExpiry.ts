/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MeteringWindow } from '@entitlements/shared/cms';

import {
  DAY_MS,
  HOUR_MS,
  SESSION_EXPIRY_GRACE_MS,
} from '../metering.constants';
import { startOfNextUtcMonth, startOfUtcDay } from './usageBuckets';

const LONGEST_CALENDAR_OVERLAP_MS = 8 * DAY_MS;

function toSeconds(timeMs: number): number {
  return Math.ceil(timeMs / 1000);
}

export function dayCountersExpireAt(
  time: Date,
  window: Exclude<MeteringWindow, { kind: 'session' }>
): number {
  const monthEndMs = startOfNextUtcMonth(time).getTime();
  const keepForMs =
    window.kind === 'sliding'
      ? window.durationMs + DAY_MS
      : LONGEST_CALENDAR_OVERLAP_MS;
  return toSeconds(monthEndMs + keepForMs);
}

export function hourCountersExpireAt(time: Date, durationMs: number): number {
  const dayEndMs = startOfUtcDay(time).getTime() + DAY_MS;
  return toSeconds(dayEndMs + durationMs + HOUR_MS);
}

export function sessionExpireAt(
  sessionStart: Date,
  durationMs: number
): number {
  return toSeconds(
    sessionStart.getTime() + durationMs + SESSION_EXPIRY_GRACE_MS
  );
}
