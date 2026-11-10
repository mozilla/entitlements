/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Message, PubSub, Subscription } from '@google-cloud/pubsub';
import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  type LoggerService,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

import {
  MeteringConfigurationManager,
  type MeteringWindow,
} from '@entitlements/shared/cms';
import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import { MeteringEventsManager } from './metering-events.manager';
import { MeteringPubSubConfig } from './metering-pubsub.config';
import { MeteringPubSubClient } from './metering-pubsub.provider';
import type { MeteringWireEvent } from './metering.schema';
import type { CounterWrites, PubSubMessage } from './metering.types';
import { UsageCountersManager } from './usage-counters.manager';
import { BatchBuffer } from './utils/batchBuffer';
import { buildCounterWrites } from './utils/buildCounterWrites';
import { hashEventId } from './utils/hashEventId';
import { parseWireEvent } from './utils/parseWireEvent';
import { dedupeKey } from './utils/redisKeys';

interface BufferedMessage {
  message: PubSubMessage;
  event: MeteringWireEvent;
  eventIdHash: string;
  key: string;
}

interface ClassifiedBatch {
  fresh: BufferedMessage[];
  duplicates: BufferedMessage[];
  pending: BufferedMessage[];
}

interface MeterWindowLookup {
  windowsBySlug: Map<string, MeteringWindow>;
  failuresBySlug: Map<string, unknown>;
}

interface InsertedTotal {
  clientId: string;
  slug: string;
  count: number;
  amount: number;
}

@Injectable()
export class MeteringConsumerService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly subscription: Subscription;
  private readonly buffer: BatchBuffer<BufferedMessage>;
  private started = false;

  constructor(
    private readonly meteringPubSubConfig: MeteringPubSubConfig,
    @Inject(MeteringPubSubClient) pubsub: PubSub,
    private readonly usageCountersManager: UsageCountersManager,
    private readonly meteringEventsManager: MeteringEventsManager,
    private readonly meteringConfigurationManager: MeteringConfigurationManager,
    @Inject(StatsDService) private readonly statsd: StatsD,
    @Inject(Logger) private readonly logger: LoggerService
  ) {
    this.subscription = pubsub.subscription(
      this.meteringPubSubConfig.subscriptionName,
      {
        flowControl: {
          maxMessages: this.meteringPubSubConfig.maxOutstandingMessages,
        },
      }
    );
    this.buffer = new BatchBuffer({
      maxSize: this.meteringPubSubConfig.consumerBatchSize,
      flushIntervalMs: this.meteringPubSubConfig.consumerFlushIntervalMs,
      onFlush: (batch) => this.processBatch(batch),
      onError: (err) => this.report('metering.consumer.flush_error', err),
    });
  }

  onApplicationBootstrap(): void {
    this.subscription.on('message', (message: Message) =>
      this.handleMessage(message)
    );
    this.subscription.on('error', (err: Error) => {
      this.report('metering.consumer.subscription_error', err);
    });
    this.started = true;
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.subscription.removeAllListeners('message');
    try {
      await this.buffer.drain();
    } finally {
      this.subscription.removeAllListeners('error');
      await this.subscription.close().catch((err: unknown) => {
        this.logger.error(err);
      });
    }
  }

  handleMessage(message: PubSubMessage): void {
    let event: MeteringWireEvent;
    try {
      event = parseWireEvent(message.data);
    } catch (err) {
      this.report('metering.consumer.invalid', err);
      message.ack();
      return;
    }

    this.statsd.increment('metering.consumer.received');
    const eventIdHash = hashEventId(event.id);
    this.buffer.push({
      message,
      event,
      eventIdHash,
      key: dedupeKey(event.clientId, eventIdHash),
    });
  }

  async flushNow(): Promise<void> {
    await this.buffer.drain();
  }

  private async processBatch(batch: BufferedMessage[]): Promise<void> {
    let ingestAllowed: boolean;
    try {
      ingestAllowed = await this.usageCountersManager.isIngestAllowed();
    } catch (err) {
      this.nackAll(batch, 'metering.consumer.dedupe_error', err);
      return;
    }
    if (!ingestAllowed) {
      for (const { message } of batch) {
        message.nack();
      }
      this.statsd.increment('metering.consumer.paused', batch.length);
      return;
    }

    let classified: ClassifiedBatch;
    try {
      classified = await this.classify(batch);
    } catch (err) {
      this.nackAll(batch, 'metering.consumer.dedupe_error', err);
      return;
    }
    const { fresh, duplicates, pending } = classified;

    if (pending.length > 0) {
      for (const { message } of pending) {
        message.nack();
      }
      this.statsd.increment('metering.consumer.pending', pending.length);
    }

    if (fresh.length > 0) {
      await this.insertFresh(fresh);
    }

    if (duplicates.length > 0) {
      for (const { message } of duplicates) {
        message.ack();
      }
      this.statsd.increment('metering.consumer.duplicate', duplicates.length);
    }
  }

  private async classify(batch: BufferedMessage[]): Promise<ClassifiedBatch> {
    const firstByKey = new Map<string, BufferedMessage>();
    const duplicates: BufferedMessage[] = [];
    for (const buffered of batch) {
      if (firstByKey.has(buffered.key)) {
        duplicates.push(buffered);
      } else {
        firstByKey.set(buffered.key, buffered);
      }
    }

    const candidates = Array.from(firstByKey.values());
    const statuses = await this.usageCountersManager.claim(
      candidates.map((candidate) => candidate.key)
    );

    const fresh: BufferedMessage[] = [];
    const pending: BufferedMessage[] = [];
    statuses.forEach((status, index) => {
      if (status === 'claimed') {
        fresh.push(candidates[index]);
      } else if (status === 'duplicate') {
        duplicates.push(candidates[index]);
      } else {
        pending.push(candidates[index]);
      }
    });

    return { fresh, duplicates, pending };
  }

  private async insertFresh(fresh: BufferedMessage[]): Promise<void> {
    const { windowsBySlug, failuresBySlug } =
      await this.findWindowsBySlug(fresh);
    for (const [slug, err] of failuresBySlug) {
      const unavailable = fresh.filter(({ event }) => event.slug === slug);
      await this.releaseClaims(unavailable.map((buffered) => buffered.key));
      this.nackAll(unavailable, 'metering.consumer.meter_error', err);
    }

    const insertable = fresh.filter(
      ({ event }) => !failuresBySlug.has(event.slug)
    );
    if (insertable.length === 0) {
      return;
    }
    const keys = insertable.map((buffered) => buffered.key);

    const ingestedAt = new Date();
    const events = insertable.map(({ event, eventIdHash }) => ({
      eventIdHash,
      clientId: event.clientId,
      slug: event.slug,
      subject: event.subject,
      amount: event.amount,
      eventTime: new Date(event.timestamp),
      ingestedAt,
    }));
    try {
      await this.meteringEventsManager.insertEvents(events);
    } catch (err) {
      await this.releaseClaims(keys);
      this.nackAll(insertable, 'metering.consumer.insert_error', err);
      return;
    }

    await this.confirmAndCount(keys, buildCounterWrites(events, windowsBySlug));

    for (const { message } of insertable) {
      message.ack();
    }
    this.countInsertedEvents(insertable);
  }

  private async findWindowsBySlug(
    fresh: BufferedMessage[]
  ): Promise<MeterWindowLookup> {
    const slugs = Array.from(new Set(fresh.map(({ event }) => event.slug)));
    const results = await Promise.allSettled(
      slugs.map((slug) =>
        this.meteringConfigurationManager.getMeterBySlug(slug)
      )
    );
    const windowsBySlug = new Map<string, MeteringWindow>();
    const failuresBySlug = new Map<string, unknown>();
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failuresBySlug.set(slugs[index], result.reason);
      } else if (result.value) {
        windowsBySlug.set(result.value.slug, result.value.window);
      }
    });
    return { windowsBySlug, failuresBySlug };
  }

  private async confirmAndCount(
    keys: string[],
    counterWrites: CounterWrites
  ): Promise<void> {
    try {
      await this.usageCountersManager.confirm(keys, counterWrites);
    } catch (err) {
      this.report('metering.consumer.confirm_error', err);
    }
  }

  private async releaseClaims(keys: string[]): Promise<void> {
    await this.usageCountersManager
      .release(keys)
      .catch((releaseErr: unknown) => {
        this.logger.error(releaseErr);
      });
  }

  private countInsertedEvents(fresh: BufferedMessage[]): void {
    const totals = new Map<string, InsertedTotal>();
    for (const { event } of fresh) {
      const key = JSON.stringify([event.clientId, event.slug]);
      const total = totals.get(key) ?? {
        clientId: event.clientId,
        slug: event.slug,
        count: 0,
        amount: 0,
      };
      total.count += 1;
      total.amount += event.amount;
      totals.set(key, total);
    }

    for (const { clientId, slug, count, amount } of totals.values()) {
      const tags = { clientId, slug };
      this.statsd.increment('metering.consumer.inserted', count, tags);
      this.statsd.increment('metering.consumer.inserted_amount', amount, tags);
    }
  }

  private nackAll(
    batch: BufferedMessage[],
    metric: string,
    err: unknown
  ): void {
    for (const { message } of batch) {
      message.nack();
    }
    this.statsd.increment(metric);
    Sentry.withScope((scope) => {
      scope.setExtra('batchSize', batch.length);
      Sentry.captureException(err);
    });
    this.logger.error(err);
  }

  private report(metric: string, err: unknown): void {
    this.statsd.increment(metric);
    Sentry.captureException(err);
    this.logger.error(err);
  }
}
