/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable, Logger, type LoggerService } from '@nestjs/common';

import {
  MeteringConfigurationManager,
  type MeteringWindow,
} from '@entitlements/shared/cms';
import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import { MeteringEventsManager } from './metering-events.manager';
import { MeteringPublisherManager } from './metering-publisher.manager';
import { MeteringSweepManager } from './metering-sweep.manager';
import { TimestampOutOfRangeError } from './metering.error';
import type { MeterSubjectKey, WindowUsage } from './metering.types';
import { isTimestampInRange } from './utils/isTimestampInRange';
import {
  type IngestUsageRequest,
  type UsageQueryParams,
  type UsageQueryResponse,
} from './metering.schema';
import { UsageCountersManager } from './usage-counters.manager';
import { UsageGrantsManager } from './usage-grants.manager';
import { requireMeterBySlug } from './utils/requireMeterBySlug';
import { resolveWindow } from './utils/resolveWindow';

@Injectable()
export class UsageService {
  constructor(
    private readonly meteringConfigurationManager: MeteringConfigurationManager,
    private readonly meteringPublisherManager: MeteringPublisherManager,
    private readonly meteringEventsManager: MeteringEventsManager,
    private readonly meteringSweepManager: MeteringSweepManager,
    private readonly usageCountersManager: UsageCountersManager,
    private readonly usageGrantsManager: UsageGrantsManager,
    @Inject(StatsDService) private readonly statsd: StatsD,
    @Inject(Logger) private readonly logger: LoggerService
  ) {}

  async ingestUsage(
    clientId: string,
    ingestUsageRequest: IngestUsageRequest,
    now: Date = new Date()
  ): Promise<void> {
    if (
      ingestUsageRequest.timestamp !== undefined &&
      !isTimestampInRange(ingestUsageRequest.timestamp, now)
    ) {
      throw new TimestampOutOfRangeError(ingestUsageRequest.timestamp);
    }

    const meter = await requireMeterBySlug(
      this.meteringConfigurationManager,
      ingestUsageRequest.slug
    );

    await this.meteringPublisherManager.publish({
      id: ingestUsageRequest.id,
      clientId,
      slug: meter.slug,
      subject: ingestUsageRequest.subject,
      amount: ingestUsageRequest.amount,
      timestamp: ingestUsageRequest.timestamp ?? now.toISOString(),
    });
  }

  async queryUsage(
    clientId: string,
    params: UsageQueryParams,
    now: Date = new Date()
  ): Promise<UsageQueryResponse> {
    const meter = await requireMeterBySlug(
      this.meteringConfigurationManager,
      params.slug
    );

    const [{ usage, windowStart, windowEnd }, grantedAmount] =
      await Promise.all([
        this.findWindowUsage(
          { clientId, slug: params.slug, subject: params.subject },
          meter.window,
          now
        ),
        this.usageGrantsManager.getActiveGrantedAmount(
          params.subject,
          params.slug,
          now
        ),
      ]);

    return {
      usage,
      limit: meter.limit + grantedAmount,
      grantedAmount,
      unit: meter.unit,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    };
  }

  private async findWindowUsage(
    key: MeterSubjectKey,
    window: MeteringWindow,
    now: Date
  ): Promise<WindowUsage> {
    try {
      const counted = await this.usageCountersManager.findWindowUsage(
        key,
        window,
        now
      );
      if (counted) {
        this.statsd.increment('metering.usage.source', { source: 'redis' });
        return counted;
      }
      this.statsd.increment('metering.usage.source', {
        source: 'clickhouse-not-populated',
      });
    } catch (err) {
      this.statsd.increment('metering.usage.source', {
        source: 'clickhouse-redis-error',
      });
      this.logger.error(err);
    }
    return this.findWindowUsageInClickHouse(key, window, now);
  }

  private async findWindowUsageInClickHouse(
    key: MeterSubjectKey,
    window: MeteringWindow,
    now: Date
  ): Promise<WindowUsage> {
    const sessionStart =
      window.kind === 'session' ? await this.findSessionStart(key) : undefined;
    const bounds = resolveWindow(window, now, sessionStart);
    const usage = await this.meteringEventsManager.sumUsage({
      ...key,
      from: bounds.windowStart,
      to: bounds.windowEnd,
    });
    return { ...bounds, usage };
  }

  private async findSessionStart(
    key: MeterSubjectKey
  ): Promise<Date | undefined> {
    const starts = await this.meteringSweepManager.findSessionStarts(
      { clientId: key.clientId, slug: key.slug, subjects: [key.subject] },
      'usageFallback'
    );
    return starts.get(key.subject);
  }
}
