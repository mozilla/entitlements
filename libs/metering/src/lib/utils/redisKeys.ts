/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MeterSubjectKey } from '../metering.types';

export const REDIS_FULLY_POPULATED_KEY = 'redis-fully-populated';
export const INGEST_PAUSED_KEY = 'ingest-paused';
export const REDIS_RUN_ID_KEY = 'redis-run-id';
export const REDIS_CHECKED_AT_KEY = 'redis-checked-at';

export const DEDUPE_CLAIMED_VALUE = 'claimed';
export const DEDUPE_STORED_VALUE = 'stored';

export function dedupeKey(clientId: string, eventIdHash: string): string {
  return `dedupe:${JSON.stringify([clientId, eventIdHash])}`;
}

export function dayCountersKey(key: MeterSubjectKey, month: string): string {
  return `usage-days:${JSON.stringify([key.clientId, key.slug, key.subject, month])}`;
}

export function hourCountersKey(key: MeterSubjectKey, day: string): string {
  return `usage-hours:${JSON.stringify([key.clientId, key.slug, key.subject, day])}`;
}

export function sessionKey(key: MeterSubjectKey): string {
  return `session:${JSON.stringify([key.clientId, key.slug, key.subject])}`;
}

export function usageGrantsCacheKey(subject: string): string {
  return `usage-grants:${JSON.stringify([subject])}`;
}

export function meterWindowKey(slug: string): string {
  return `meter-window:${JSON.stringify([slug])}`;
}
