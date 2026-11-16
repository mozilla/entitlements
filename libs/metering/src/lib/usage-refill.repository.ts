/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ClickHouseClient, type ClickHouseParams } from './clickhouse.client';
import { MeteringUsageCountersConfig } from './metering-usage-counters.config';
import { EVENTS_TABLE, SESSIONS_TABLE } from './metering.constants';
import type { MeterKey } from './metering.types';
import { toClickHouseDateTime } from './utils/toClickHouseDateTime';

const dayTotalRowSchema = z.object({
  subject: z.string(),
  day: z.string(),
  usage: z.coerce.number(),
});

const hourTotalRowSchema = z.object({
  subject: z.string(),
  hour: z.string(),
  usage: z.coerce.number(),
});

const openSessionRowSchema = z.object({
  subject: z.string(),
  started_at_iso: z.string(),
  usage: z.coerce.number(),
});

const ingestedEventRowSchema = z.object({
  client_id: z.string(),
  event_id_hash: z.string(),
  ingested_at_iso: z.string(),
});

export type DayTotalRow = z.infer<typeof dayTotalRowSchema>;
export type HourTotalRow = z.infer<typeof hourTotalRowSchema>;
export type OpenSessionRow = z.infer<typeof openSessionRowSchema>;
export type IngestedEventRow = z.infer<typeof ingestedEventRowSchema>;

export interface RefillRangeParams extends MeterKey {
  from: Date;
  to: Date;
  touchedSince: Date | null;
}

export interface RefillSessionsParams extends MeterKey {
  expiredBefore: Date;
  to: Date;
  touchedSince: Date | null;
}

const TOUCHED_SUBJECTS_FILTER = `
  AND subject IN
  (
      SELECT DISTINCT subject
      FROM ${EVENTS_TABLE}
      WHERE client_id = {clientId:String}
        AND slug = {slug:String}
        AND ingested_at >= {touchedSince:DateTime64(3, 'UTC')}
  )`;

function dayTotalsSql(subjectFilter: string): string {
  return `
SELECT subject, toString(toDate(event_time)) AS day, sum(amount) AS usage
FROM ${EVENTS_TABLE}
WHERE client_id = {clientId:String}
  AND slug = {slug:String}
  AND event_time >= {from:DateTime64(3, 'UTC')}
  AND event_time < {to:DateTime64(3, 'UTC')}${subjectFilter}
GROUP BY subject, day`;
}

function hourTotalsSql(subjectFilter: string): string {
  return `
SELECT
    subject,
    formatDateTime(toStartOfHour(event_time), '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS hour,
    sum(amount) AS usage
FROM ${EVENTS_TABLE}
WHERE client_id = {clientId:String}
  AND slug = {slug:String}
  AND event_time >= {from:DateTime64(3, 'UTC')}
  AND event_time < {to:DateTime64(3, 'UTC')}${subjectFilter}
GROUP BY subject, hour`;
}

function openSessionsSql(subjectFilter: string): string {
  return `
WITH open_sessions AS
(
    SELECT subject, max(session_start) AS started_at
    FROM ${SESSIONS_TABLE}
    WHERE client_id = {clientId:String}
      AND slug = {slug:String}${subjectFilter}
    GROUP BY subject
    HAVING started_at > {expiredBefore:DateTime64(3, 'UTC')}
)
SELECT
    s.subject AS subject,
    formatDateTime(s.started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS started_at_iso,
    sumIf(e.amount, e.event_time >= s.started_at) AS usage
FROM open_sessions AS s
LEFT JOIN
(
    SELECT subject, event_time, amount
    FROM ${EVENTS_TABLE}
    WHERE client_id = {clientId:String}
      AND slug = {slug:String}
      AND subject IN (SELECT subject FROM open_sessions)
      AND event_time >= {expiredBefore:DateTime64(3, 'UTC')}
      AND event_time < {to:DateTime64(3, 'UTC')}
) AS e ON e.subject = s.subject
GROUP BY s.subject, s.started_at`;
}

const INGESTED_EVENTS_SQL = `
SELECT
    client_id,
    toString(event_id_hash) AS event_id_hash,
    formatDateTime(ingested_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS ingested_at_iso
FROM ${EVENTS_TABLE}
WHERE ingested_at >= {ingestedSince:DateTime64(3, 'UTC')}`;

const DAY_TOTALS_SQL = dayTotalsSql('');
const TOUCHED_DAY_TOTALS_SQL = dayTotalsSql(TOUCHED_SUBJECTS_FILTER);
const HOUR_TOTALS_SQL = hourTotalsSql('');
const TOUCHED_HOUR_TOTALS_SQL = hourTotalsSql(TOUCHED_SUBJECTS_FILTER);
const OPEN_SESSIONS_SQL = openSessionsSql('');
const TOUCHED_OPEN_SESSIONS_SQL = openSessionsSql(TOUCHED_SUBJECTS_FILTER);

@Injectable()
export class UsageRefillRepository {
  constructor(
    private readonly clickHouseClient: ClickHouseClient,
    private readonly usageCountersConfig: MeteringUsageCountersConfig
  ) {}

  streamDayTotals(params: RefillRangeParams): AsyncGenerator<DayTotalRow> {
    return this.stream(
      params.touchedSince ? TOUCHED_DAY_TOTALS_SQL : DAY_TOTALS_SQL,
      dayTotalRowSchema,
      this.rangeParams(params)
    );
  }

  streamHourTotals(params: RefillRangeParams): AsyncGenerator<HourTotalRow> {
    return this.stream(
      params.touchedSince ? TOUCHED_HOUR_TOTALS_SQL : HOUR_TOTALS_SQL,
      hourTotalRowSchema,
      this.rangeParams(params)
    );
  }

  streamOpenSessions(
    params: RefillSessionsParams
  ): AsyncGenerator<OpenSessionRow> {
    return this.stream(
      params.touchedSince ? TOUCHED_OPEN_SESSIONS_SQL : OPEN_SESSIONS_SQL,
      openSessionRowSchema,
      {
        clientId: params.clientId,
        slug: params.slug,
        expiredBefore: toClickHouseDateTime(params.expiredBefore),
        to: toClickHouseDateTime(params.to),
        ...this.touchedSinceParam(params.touchedSince),
      }
    );
  }

  streamIngestedEvents(ingestedSince: Date): AsyncGenerator<IngestedEventRow> {
    return this.stream(INGESTED_EVENTS_SQL, ingestedEventRowSchema, {
      ingestedSince: toClickHouseDateTime(ingestedSince),
    });
  }

  private rangeParams(params: RefillRangeParams): ClickHouseParams {
    return {
      clientId: params.clientId,
      slug: params.slug,
      from: toClickHouseDateTime(params.from),
      to: toClickHouseDateTime(params.to),
      ...this.touchedSinceParam(params.touchedSince),
    };
  }

  private touchedSinceParam(touchedSince: Date | null): ClickHouseParams {
    return touchedSince
      ? { touchedSince: toClickHouseDateTime(touchedSince) }
      : {};
  }

  private stream<T>(
    sql: string,
    rowSchema: z.ZodType<T>,
    params: ClickHouseParams
  ): AsyncGenerator<T> {
    return this.clickHouseClient.stream({
      sql,
      rowSchema,
      params,
      settings: {
        max_execution_time: this.usageCountersConfig.refillTimeoutSeconds,
        select_sequential_consistency: 1,
      },
      timeoutMs: this.usageCountersConfig.refillTimeoutSeconds * 1000,
    });
  }
}
