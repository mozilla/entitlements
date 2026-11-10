/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { RateLimiterAbstract } from 'rate-limiter-flexible';

export interface MeteringEventInput {
  eventIdHash: string;
  clientId: string;
  slug: string;
  subject: string;
  amount: number;
  eventTime: Date;
  ingestedAt: Date;
}

export interface MeterKey {
  clientId: string;
  slug: string;
}

export interface SumUsageParams extends MeterKey {
  subject: string;
  from: Date;
  to: Date;
}

export type DedupeStatus = 'claimed' | 'duplicate' | 'pending';

export interface PubSubMessage {
  data: Buffer;
  ack(): void;
  nack(): void;
}

export interface MeteringRedisPipeline {
  set(
    key: string,
    value: string,
    expiryMode?: string,
    time?: number,
    setMode?: string
  ): unknown;
  get(key: string): unknown;
  del(...keys: string[]): unknown;
  hset(key: string, ...fieldsAndValues: Array<string | number>): unknown;
  hmget(key: string, ...fields: string[]): unknown;
  hincrby(key: string, field: string, increment: number): unknown;
  expireat(key: string, timestamp: number): unknown;
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: Array<string | number>
  ): unknown;
  exec(): Promise<Array<[Error | null, unknown]>>;
}

export interface MeteringRedis {
  pipeline(): MeteringRedisPipeline;
  multi(): MeteringRedisPipeline;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: string,
    time: number
  ): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  info(section: string): Promise<string>;
  quit(): Promise<'OK'>;
  disconnect(): void;
}

export interface ClickHouseRateLimiters {
  read: RateLimiterAbstract;
  write: RateLimiterAbstract;
  usageFallback: RateLimiterAbstract;
}

export interface MeterSubjectKey extends MeterKey {
  subject: string;
}

export interface CountedEvent extends MeterSubjectKey {
  amount: number;
  eventTime: Date;
}

export interface CounterIncrement {
  key: string;
  field: string;
  amount: number;
}

export interface CounterExpiry {
  key: string;
  expireAtSeconds: number;
}

export interface SessionEventWrite {
  key: string;
  eventTimeMs: number;
  amount: number;
  durationMs: number;
}

export interface CounterWrites {
  increments: CounterIncrement[];
  expiries: CounterExpiry[];
  sessionEvents: SessionEventWrite[];
}

export interface CounterRead {
  key: string;
  fields: string[];
}

export interface WindowUsage {
  usage: number;
  windowStart: Date;
  windowEnd: Date;
}

export interface SentNotification {
  windowId: string | null;
  sentAt: Date;
}

export type SweepOutcome =
  | 'meter-not-configured'
  | 'no-webhooks'
  | 'no-thresholds'
  | 'no-candidates'
  | 'no-crossings'
  | 'dispatch-failed'
  | 'dispatched';

export interface SweepResult {
  outcome: SweepOutcome;
  candidates: number;
  dispatched: number;
  held: boolean;
  watermark: string;
}

export interface SweepAllResult {
  total: number;
  held: number;
  failed: number;
}

export interface FindActiveMetersParams {
  ingestedSince: Date;
}

export interface SweepCandidate {
  subject: string;
  usage: number;
}

export interface FindWindowCandidatesParams extends MeterKey {
  from: Date;
  to: Date;
  ingestedSince: Date;
  ingestedUntil: Date;
  eventTimeFloor: Date;
  minUsage: number;
}

export interface FindSessionCandidatesParams extends MeterKey {
  expiredBefore: Date;
  to: Date;
  minUsage: number;
}

export interface FindNewSessionStartsParams extends MeterKey {
  ingestedSince: Date;
  ingestedUntil: Date;
  eventTimeFloor: Date;
  to: Date;
  durationMs: number;
}

export interface SubjectsParams extends MeterKey {
  subjects: string[];
}

export interface FindSessionUsageParams extends MeterKey {
  sessions: Array<{ subject: string; sessionStart: Date }>;
  to: Date;
}

export interface SessionUsage {
  subject: string;
  sessionStart: Date;
  usage: number;
}

export interface AdvanceWatermarkParams extends MeterKey {
  watermark: Date;
  updatedAt: Date;
}

export interface RecordedNotification extends MeterKey {
  subject: string;
  threshold: number;
  signingClientId: string;
  windowId: string | null;
  sentAt: Date;
}

export interface SessionStartRecord extends MeterKey {
  subject: string;
  sessionStart: Date;
}

export type MetricsReportOutcome = 'meter-not-configured' | 'reported';

export interface MetricsReportAllResult {
  total: number;
  failed: number;
}

export interface FindActiveSubjectCountParams extends MeterKey {
  from: Date;
  to: Date;
}

export interface FindNotifiedSubjectCountsParams extends MeterKey {
  from: Date;
  to: Date;
  thresholds: number[];
}

export interface NotifiedSubjectCount {
  threshold: number;
  subjectCount: number;
}

export interface WebhookDispatchParams {
  signingClientId: string;
  url: string;
  slug: string;
  subject: string;
  threshold: number;
  currentUsage: number;
  limit: number;
  grantedAmount: number;
  unit: string;
  windowStart: Date;
  windowEnd: Date;
  idempotencyKey: string;
}
