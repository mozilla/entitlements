/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable } from '@nestjs/common';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { z } from 'zod';

import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import { ClickHouseRateLimitersToken } from './clickhouse-rate-limiter.provider';
import { ClickHouseConfig } from './clickhouse.config';
import {
  ClickHouseError,
  ClickHouseRateLimitError,
  ClickHouseTableNameError,
} from './metering.error';
import type { ClickHouseRateLimiters } from './metering.types';
import { toError } from './utils/toError';

const TABLE_IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;
const RATE_LIMIT_KEY = 'global';

export type ClickHouseParams = Record<string, string | number>;

export type ClickHouseReadBudget = 'read' | 'usageFallback';

export interface ClickHouseQuery<T> {
  sql: string;
  rowSchema: z.ZodType<T>;
  params?: ClickHouseParams;
  budget?: ClickHouseReadBudget;
}

export interface ClickHouseStreamQuery<T> extends ClickHouseQuery<T> {
  settings?: ClickHouseParams;
  timeoutMs?: number;
}

export interface ClickHouseInsert {
  table: string;
  rows: unknown[];
}

@Injectable()
export class ClickHouseClient {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly settings: ClickHouseParams;

  constructor(
    clickHouseConfig: ClickHouseConfig,
    @Inject(StatsDService) private readonly statsd: StatsD,
    @Inject(ClickHouseRateLimitersToken)
    private readonly rateLimiters: ClickHouseRateLimiters
  ) {
    this.endpoint = clickHouseConfig.url;
    this.timeoutMs = clickHouseConfig.requestTimeoutMs;
    this.headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-ClickHouse-User': clickHouseConfig.username,
      'X-ClickHouse-Database': clickHouseConfig.database,
    };
    if (clickHouseConfig.password) {
      this.headers['X-ClickHouse-Key'] = clickHouseConfig.password;
    }
    this.settings = {
      max_execution_time: clickHouseConfig.maxExecutionTimeSeconds,
      max_threads: clickHouseConfig.maxThreads,
      max_memory_usage: clickHouseConfig.maxMemoryUsageBytes,
      max_bytes_before_external_group_by:
        clickHouseConfig.maxBytesBeforeExternalGroupBy,
    };
  }

  async query<T>({
    sql,
    rowSchema,
    params,
    budget = 'read',
  }: ClickHouseQuery<T>): Promise<T[]> {
    const body = await this.send(
      'query',
      budget,
      this.querySearch(params),
      sql
    );
    return this.parseRows(body, rowSchema);
  }

  async insert({ table, rows }: ClickHouseInsert): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    if (!TABLE_IDENTIFIER.test(table)) {
      throw new ClickHouseTableNameError(table);
    }

    await this.send(
      'insert',
      'write',
      { ...this.settings, query: `INSERT INTO ${table} FORMAT JSONEachRow` },
      rows.map((row) => JSON.stringify(row)).join('\n')
    );
  }

  async command(sql: string): Promise<void> {
    await this.send('command', 'write', { ...this.settings }, sql);
  }

  async *stream<T>({
    sql,
    rowSchema,
    params,
    budget = 'read',
    settings,
    timeoutMs,
  }: ClickHouseStreamQuery<T>): AsyncGenerator<T> {
    const search = this.querySearch(params, settings);
    await this.consumeBudget('stream', budget);

    let response: Response;
    try {
      response = await this.post(search, sql, timeoutMs ?? this.timeoutMs);
    } catch (err) {
      throw new ClickHouseError('stream', toError(err));
    }
    if (!response.ok || !response.body) {
      throw await this.responseError('stream', response);
    }

    for await (const line of this.readLines(response.body)) {
      yield this.parseRow(line, rowSchema);
    }
  }

  private querySearch(
    params: ClickHouseParams | undefined,
    settings?: ClickHouseParams
  ): ClickHouseParams {
    const search: ClickHouseParams = {
      ...this.settings,
      ...settings,
      default_format: 'JSONEachRow',
    };
    for (const [name, value] of Object.entries(params ?? {})) {
      search[`param_${name}`] = value;
    }
    return search;
  }

  private async send(
    operation: string,
    budget: keyof ClickHouseRateLimiters,
    search: ClickHouseParams,
    body: string
  ): Promise<string> {
    await this.consumeBudget(operation, budget);

    let response: Response;
    let text: string;
    try {
      response = await this.post(search, body, this.timeoutMs);
      if (!response.ok) {
        throw await this.responseError(operation, response);
      }
      text = await response.text();
    } catch (err) {
      if (err instanceof ClickHouseError) {
        throw err;
      }
      throw new ClickHouseError(operation, toError(err));
    }
    return text;
  }

  private async consumeBudget(
    operation: string,
    budget: keyof ClickHouseRateLimiters
  ): Promise<void> {
    try {
      await this.rateLimiters[budget].consume(RATE_LIMIT_KEY);
    } catch (rejection) {
      if (rejection instanceof RateLimiterRes) {
        this.statsd.increment('metering.clickhouse.limit_rejected', {
          operation,
          budget,
        });
        throw new ClickHouseRateLimitError(operation);
      }
      this.statsd.increment('metering.clickhouse.limiter_error', {
        operation,
        budget,
      });
      if (budget !== 'write') {
        throw new ClickHouseRateLimitError(operation);
      }
    }
  }

  private post(
    search: ClickHouseParams,
    body: string,
    timeoutMs: number
  ): Promise<Response> {
    const url = new URL(this.endpoint);
    for (const [name, value] of Object.entries(search)) {
      url.searchParams.set(name, String(value));
    }
    return fetch(url, {
      method: 'POST',
      headers: this.headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async responseError(
    operation: string,
    response: Response
  ): Promise<ClickHouseError> {
    const text = await response.text().catch(() => '');
    return new ClickHouseError(
      operation,
      new Error(`ClickHouse responded ${response.status}: ${text.trim()}`)
    );
  }

  private async *readLines(
    body: ReadableStream<Uint8Array>
  ): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for await (const chunk of body) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.trim().length > 0) {
            yield line;
          }
          newline = buffered.indexOf('\n');
        }
      }
    } catch (err) {
      throw new ClickHouseError('stream', toError(err));
    }
    buffered += decoder.decode();
    if (buffered.trim().length > 0) {
      yield buffered;
    }
  }

  private parseRows<T>(body: string, rowSchema: z.ZodType<T>): T[] {
    return body
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => this.parseRow(line, rowSchema));
  }

  private parseRow<T>(line: string, rowSchema: z.ZodType<T>): T {
    try {
      return rowSchema.parse(JSON.parse(line));
    } catch (err) {
      throw new ClickHouseError('parse', toError(err));
    }
  }
}
