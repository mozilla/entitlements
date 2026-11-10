/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout as sleep } from 'node:timers/promises';

import { Inject, Injectable, Logger, type LoggerService } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

import { MeteringConfigurationManager } from '@entitlements/shared/cms';
import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import { MeteringRedisConfig } from './metering-redis.config';
import { MeteringSweepConfig } from './metering-sweep.config';
import { MeteringSweepManager } from './metering-sweep.manager';
import { MeteringUsageCountersConfig } from './metering-usage-counters.config';
import type { MeterKey } from './metering.types';
import { UsageCountersManager } from './usage-counters.manager';
import {
  UsageRefillManager,
  type RefillCounts,
  type RefillMeter,
} from './usage-refill.manager';

export type UsageRefillOutcome =
  'refilled' | 'repaired' | 'meters-rebuilt' | 'checked';

const UNAVAILABLE_METER_FINGERPRINT = 'unavailable';

interface FoundMeters {
  meters: RefillMeter[];
  unavailableSlugs: string[];
}

interface RebuildRange {
  touchedSince: Date | null;
  dedupeSince: Date | null;
}

@Injectable()
export class UsageRefillService {
  constructor(
    private readonly meteringConfigurationManager: MeteringConfigurationManager,
    private readonly meteringSweepManager: MeteringSweepManager,
    private readonly meteringSweepConfig: MeteringSweepConfig,
    private readonly meteringRedisConfig: MeteringRedisConfig,
    private readonly usageCountersConfig: MeteringUsageCountersConfig,
    private readonly usageCountersManager: UsageCountersManager,
    private readonly usageRefillManager: UsageRefillManager,
    @Inject(StatsDService) private readonly statsd: StatsD,
    @Inject(Logger) private readonly logger: LoggerService
  ) {}

  async refillIfNeeded(now: Date = new Date()): Promise<UsageRefillOutcome> {
    const startedAt = Date.now();
    const outcome = await this.runRefill(now);
    this.statsd.increment('metering.refill', { outcome });
    this.statsd.timing('metering.refill.duration', Date.now() - startedAt, {
      outcome,
    });
    return outcome;
  }

  private async runRefill(now: Date): Promise<UsageRefillOutcome> {
    const runId = await this.usageCountersManager.findRedisRunId();
    const state = await this.usageCountersManager.findPopulationState();
    const dedupeSince = new Date(
      now.getTime() - this.meteringRedisConfig.dedupeTtlSeconds * 1000
    );

    if (!state.fullyPopulated) {
      this.logger.warn('Redis is not fully populated, refilling it');
      await this.withIngestPaused(now, async () => {
        const { meters, unavailableSlugs } = await this.findMeters(now);
        await this.rebuild(meters, { touchedSince: null, dedupeSince }, now);
        await this.usageCountersManager.recordMeterWindowFingerprints(
          this.fingerprints(meters, unavailableSlugs)
        );
      });
      await this.usageCountersManager.markFullyPopulated(runId, now);
      return 'refilled';
    }

    if (state.runId !== runId) {
      const lastCheckedMs = state.checkedAt?.getTime() ?? dedupeSince.getTime();
      const since = new Date(
        lastCheckedMs - this.usageCountersConfig.repairMarginMs
      );
      this.logger.warn(
        `Redis run id changed, repairing data ingested since ${since.toISOString()}`
      );
      await this.withIngestPaused(now, async () => {
        const { meters, unavailableSlugs } = await this.findMeters(now);
        await this.rebuild(
          meters,
          { touchedSince: since, dedupeSince: since },
          now
        );
        await this.usageCountersManager.recordMeterWindowFingerprints(
          this.fingerprints([], unavailableSlugs)
        );
      });
      await this.usageCountersManager.markChecked(runId, now);
      return 'repaired';
    }

    const { meters } = await this.findMeters(now);
    const fingerprints =
      await this.usageCountersManager.findMeterWindowFingerprints(
        Array.from(new Set(meters.map((meter) => meter.slug)))
      );
    const newMeters = meters.filter(
      (meter) => fingerprints.get(meter.slug) === null
    );
    const changed = meters.filter((meter) => {
      const fingerprint = fingerprints.get(meter.slug);
      return fingerprint !== null && fingerprint !== this.fingerprint(meter);
    });

    await this.usageCountersManager.recordMeterWindowFingerprints(
      this.fingerprints(newMeters, [])
    );
    if (changed.length > 0) {
      this.logger.warn(
        `Meter windows changed for ${changed
          .map((meter) => `${meter.clientId}/${meter.slug}`)
          .join(', ')}, rebuilding their counters`
      );
      await this.withIngestPaused(now, () =>
        this.rebuild(changed, { touchedSince: null, dedupeSince: null }, now)
      );
      await this.usageCountersManager.recordMeterWindowFingerprints(
        this.fingerprints(changed, [])
      );
      await this.usageCountersManager.markChecked(runId, now);
      return 'meters-rebuilt';
    }

    await this.usageCountersManager.markChecked(runId, now);
    return 'checked';
  }

  private async findMeters(now: Date): Promise<FoundMeters> {
    const meterKeys = await this.meteringSweepManager.findActiveMeters({
      ingestedSince: new Date(
        now.getTime() -
          this.meteringSweepConfig.lookbackMs -
          this.meteringSweepConfig.watermarkLagMs
      ),
    });
    const meters: RefillMeter[] = [];
    const unavailableSlugs: string[] = [];
    for (const meterKey of meterKeys) {
      try {
        const meter = await this.meteringConfigurationManager.getMeterBySlug(
          meterKey.slug
        );
        if (meter) {
          meters.push({ ...meterKey, window: meter.window });
        }
      } catch (err) {
        unavailableSlugs.push(meterKey.slug);
        this.reportMeterError(meterKey, err);
      }
    }
    return { meters, unavailableSlugs };
  }

  private reportMeterError(meterKey: MeterKey, err: unknown): void {
    this.statsd.increment('metering.refill.meter_error', {
      slug: meterKey.slug,
    });
    Sentry.withScope((scope) => {
      scope.setTag('clientId', meterKey.clientId);
      scope.setTag('slug', meterKey.slug);
      Sentry.captureException(err);
    });
    this.logger.error(err);
  }

  private fingerprint(meter: RefillMeter): string {
    return JSON.stringify(meter.window);
  }

  private fingerprints(
    meters: RefillMeter[],
    unavailableSlugs: string[]
  ): Map<string, string> {
    return new Map([
      ...unavailableSlugs.map((slug): [string, string] => [
        slug,
        UNAVAILABLE_METER_FINGERPRINT,
      ]),
      ...meters.map((meter): [string, string] => [
        meter.slug,
        this.fingerprint(meter),
      ]),
    ]);
  }

  private async withIngestPaused(
    now: Date,
    rebuild: () => Promise<void>
  ): Promise<void> {
    await this.usageCountersManager.pauseIngest(
      this.usageCountersConfig.ingestPauseTtlSeconds,
      now
    );
    try {
      await sleep(this.usageCountersConfig.ingestPauseSettleMs);
      await rebuild();
    } finally {
      await this.usageCountersManager.resumeIngest();
    }
  }

  private async rebuild(
    meters: RefillMeter[],
    { touchedSince, dedupeSince }: RebuildRange,
    now: Date
  ): Promise<void> {
    const totals: RefillCounts = { counters: 0, sessions: 0, dedupeKeys: 0 };
    for (const meter of meters) {
      const counts = await this.usageRefillManager.refillMeter(
        meter,
        touchedSince,
        now
      );
      totals.counters += counts.counters;
      totals.sessions += counts.sessions;
    }
    if (dedupeSince) {
      totals.dedupeKeys = await this.usageRefillManager.refillDedupeKeys(
        dedupeSince,
        now
      );
    }
    this.statsd.gauge('metering.refill.counters', totals.counters);
    this.statsd.gauge('metering.refill.sessions', totals.sessions);
    this.statsd.gauge('metering.refill.dedupe_keys', totals.dedupeKeys);
    this.logger.log(
      `Refilled ${totals.counters} counters, ${totals.sessions} sessions and ${totals.dedupeKeys} dedupe keys for ${meters.length} meters`
    );
  }
}
