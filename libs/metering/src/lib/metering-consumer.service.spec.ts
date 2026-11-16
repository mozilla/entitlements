/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PubSub } from '@google-cloud/pubsub';
import { Logger } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  MeteringConfigurationManager,
  StrapiMeterFactory,
  type StrapiMeter,
} from '@entitlements/shared/cms';
import {
  StatsDService,
  type StatsD,
} from '@entitlements/shared/metrics/statsd';

import {
  MockMeteringPubSubConfig,
  MeteringPubSubConfig,
} from './metering-pubsub.config';
import { MeteringConsumerService } from './metering-consumer.service';
import { MeteringEventsManager } from './metering-events.manager';
import { ClickHouseError, UsageCountersError } from './metering.error';
import type { DedupeStatus, PubSubMessage } from './metering.types';
import { UsageCountersManager } from './usage-counters.manager';
import { MeteringPubSubClient } from './metering-pubsub.provider';
import { dayCountersExpireAt } from './utils/counterExpiry';
import { hashEventId } from './utils/hashEventId';
import { dayCountersKey, dedupeKey, sessionKey } from './utils/redisKeys';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
  withScope: jest.fn((callback: (scope: unknown) => void) =>
    callback({ setExtra: jest.fn() })
  ),
}));

function messageFor(payload: unknown): PubSubMessage & {
  ack: jest.Mock;
  nack: jest.Mock;
} {
  return {
    data: Buffer.from(JSON.stringify(payload), 'utf8'),
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

const WIRE_EVENT = {
  id: 'event-1',
  clientId: 'vpn',
  slug: 'tokens',
  subject: 'user-1',
  amount: 5,
  timestamp: '2026-05-07T15:23:45.123Z',
};

const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;

function monthlyMeter(slug: string): StrapiMeter {
  return StrapiMeterFactory({
    slug,
    window: { kind: 'calendar', period: 'monthly' },
  });
}

function sessionMeter(slug: string): StrapiMeter {
  return StrapiMeterFactory({
    slug,
    window: { kind: 'session', durationMs: SESSION_DURATION_MS },
  });
}

describe('MeteringConsumerService', () => {
  let service: MeteringConsumerService;
  let usageCountersManager: jest.Mocked<
    Pick<
      UsageCountersManager,
      'isIngestAllowed' | 'claim' | 'confirm' | 'release'
    >
  >;
  let meteringEventsManager: jest.Mocked<
    Pick<MeteringEventsManager, 'insertEvents'>
  >;
  let meteringConfigurationManager: jest.Mocked<
    Pick<MeteringConfigurationManager, 'getMeterBySlug'>
  >;
  let statsd: jest.Mocked<Pick<StatsD, 'increment'>>;
  let logger: jest.Mocked<Pick<LoggerService, 'error'>>;
  let subscriptionOn: jest.Mock;
  let subscriptionClose: jest.Mock;
  let removeAllListeners: jest.Mock;

  async function build(
    pubsubOverrides: Partial<MeteringPubSubConfig> = {}
  ): Promise<void> {
    subscriptionOn = jest.fn();
    subscriptionClose = jest.fn().mockResolvedValue(undefined);
    removeAllListeners = jest.fn();
    usageCountersManager = {
      isIngestAllowed: jest.fn().mockResolvedValue(true),
      claim: jest
        .fn()
        .mockImplementation((keys: string[]) =>
          Promise.resolve(keys.map((): DedupeStatus => 'claimed'))
        ),
      confirm: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    meteringEventsManager = {
      insertEvents: jest.fn().mockResolvedValue(undefined),
    };
    meteringConfigurationManager = {
      getMeterBySlug: jest
        .fn()
        .mockImplementation((slug: string) =>
          Promise.resolve(monthlyMeter(slug))
        ),
    };
    statsd = { increment: jest.fn() };
    logger = { error: jest.fn() };

    const pubsub: Pick<PubSub, 'subscription'> = {
      subscription: jest.fn().mockReturnValue({
        on: subscriptionOn,
        close: subscriptionClose,
        removeAllListeners,
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeteringConsumerService,
        {
          provide: MeteringPubSubConfig,
          useValue: { ...MockMeteringPubSubConfig, ...pubsubOverrides },
        },
        { provide: MeteringPubSubClient, useValue: pubsub },
        { provide: UsageCountersManager, useValue: usageCountersManager },
        { provide: MeteringEventsManager, useValue: meteringEventsManager },
        {
          provide: MeteringConfigurationManager,
          useValue: meteringConfigurationManager,
        },
        { provide: StatsDService, useValue: statsd },
        { provide: Logger, useValue: logger },
      ],
    }).compile();

    service = moduleRef.get(MeteringConsumerService);
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    await build({ consumerBatchSize: 2, consumerFlushIntervalMs: 5_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('onApplicationBootstrap', () => {
    it('subscribes to messages', () => {
      service.onApplicationBootstrap();

      expect(subscriptionOn).toHaveBeenCalledWith(
        'message',
        expect.any(Function)
      );
    });

    it('subscribes to subscription errors', () => {
      service.onApplicationBootstrap();

      expect(subscriptionOn).toHaveBeenCalledWith(
        'error',
        expect.any(Function)
      );
    });
  });

  describe('handleMessage', () => {
    it('flushes and acks once the batch size is reached', async () => {
      const first = messageFor(WIRE_EVENT);
      const second = messageFor({ ...WIRE_EVENT, id: 'event-2' });

      service.handleMessage(first);
      expect(meteringEventsManager.insertEvents).not.toHaveBeenCalled();

      service.handleMessage(second);
      await service.flushNow();

      expect(meteringEventsManager.insertEvents).toHaveBeenCalledTimes(1);
      expect(first.ack).toHaveBeenCalled();
      expect(second.ack).toHaveBeenCalled();
    });

    it('maps the wire event onto ClickHouse row inputs', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      await service.flushNow();

      expect(meteringEventsManager.insertEvents).toHaveBeenCalledWith([
        {
          eventIdHash: hashEventId('event-1'),
          clientId: 'vpn',
          slug: 'tokens',
          subject: 'user-1',
          amount: 5,
          eventTime: new Date('2026-05-07T15:23:45.123Z'),
          ingestedAt: expect.any(Date),
        },
      ]);
    });

    it('flushes on the interval when the batch stays under size', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));

      jest.advanceTimersByTime(5_000);
      await Promise.resolve();

      expect(usageCountersManager.claim).toHaveBeenCalledTimes(1);
    });

    it('acks and drops a message that is not valid JSON', () => {
      const message: PubSubMessage & { ack: jest.Mock; nack: jest.Mock } = {
        data: Buffer.from('{not json', 'utf8'),
        ack: jest.fn(),
        nack: jest.fn(),
      };

      service.handleMessage(message);

      expect(message.ack).toHaveBeenCalled();
      expect(message.nack).not.toHaveBeenCalled();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.invalid'
      );
    });

    it('acks and drops a message that fails schema validation', () => {
      const message = messageFor({ ...WIRE_EVENT, amount: -1 });

      service.handleMessage(message);

      expect(message.ack).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });

    it('acks and drops a message with a fractional amount', () => {
      const message = messageFor({ ...WIRE_EVENT, amount: 1.5 });

      service.handleMessage(message);

      expect(message.ack).toHaveBeenCalled();
    });
  });

  describe('dedupe', () => {
    it('claims one key per unique event, scoped by client id', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      service.handleMessage(
        messageFor({ ...WIRE_EVENT, id: 'event-2', clientId: 'relay' })
      );
      await service.flushNow();

      expect(usageCountersManager.claim).toHaveBeenCalledWith([
        dedupeKey('vpn', hashEventId('event-1')),
        dedupeKey('relay', hashEventId('event-2')),
      ]);
    });

    it('keeps events apart when a client id and event id contain the delimiter', async () => {
      service.handleMessage(
        messageFor({ ...WIRE_EVENT, clientId: 'a', id: 'b:c' })
      );
      service.handleMessage(
        messageFor({ ...WIRE_EVENT, clientId: 'a:b', id: 'c' })
      );
      await service.flushNow();

      expect(usageCountersManager.claim).toHaveBeenCalledWith([
        dedupeKey('a', hashEventId('b:c')),
        dedupeKey('a:b', hashEventId('c')),
      ]);
    });

    it('inserts one row and acks both copies of an in-batch duplicate', async () => {
      const first = messageFor(WIRE_EVENT);
      const copy = messageFor(WIRE_EVENT);

      service.handleMessage(first);
      service.handleMessage(copy);
      await service.flushNow();

      expect(usageCountersManager.claim).toHaveBeenCalledWith([
        dedupeKey('vpn', hashEventId('event-1')),
      ]);
      expect(meteringEventsManager.insertEvents).toHaveBeenCalledTimes(1);
      expect(meteringEventsManager.insertEvents.mock.calls[0][0]).toHaveLength(
        1
      );
      expect(first.ack).toHaveBeenCalled();
      expect(copy.ack).toHaveBeenCalled();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.duplicate',
        1
      );
    });

    it('treats the same id under two client ids as two distinct events', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      service.handleMessage(messageFor({ ...WIRE_EVENT, clientId: 'relay' }));
      await service.flushNow();

      expect(meteringEventsManager.insertEvents.mock.calls[0][0]).toHaveLength(
        2
      );
    });

    it('acks an already-stored duplicate without inserting it', async () => {
      usageCountersManager.claim.mockResolvedValue(['duplicate']);
      const message = messageFor(WIRE_EVENT);

      service.handleMessage(message);
      await service.flushNow();

      expect(meteringEventsManager.insertEvents).not.toHaveBeenCalled();
      expect(message.ack).toHaveBeenCalled();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.duplicate',
        1
      );
    });

    it('nacks an event whose key is claimed by an unfinished batch', async () => {
      usageCountersManager.claim.mockResolvedValue(['pending']);
      const message = messageFor(WIRE_EVENT);

      service.handleMessage(message);
      await service.flushNow();

      expect(meteringEventsManager.insertEvents).not.toHaveBeenCalled();
      expect(message.nack).toHaveBeenCalled();
      expect(message.ack).not.toHaveBeenCalled();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.pending',
        1
      );
    });

    it('nacks the whole batch and inserts nothing when redis is down', async () => {
      usageCountersManager.claim.mockRejectedValue(
        new UsageCountersError('claim', new Error('connection closed'))
      );
      const first = messageFor(WIRE_EVENT);
      const second = messageFor({ ...WIRE_EVENT, id: 'event-2' });

      service.handleMessage(first);
      service.handleMessage(second);
      await service.flushNow();

      expect(meteringEventsManager.insertEvents).not.toHaveBeenCalled();
      expect(first.nack).toHaveBeenCalled();
      expect(second.nack).toHaveBeenCalled();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.dedupe_error'
      );
    });

    it('confirms the claims with the counter writes after a successful insert', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      await service.flushNow();

      const counterKey = dayCountersKey(WIRE_EVENT, '2026-05');
      expect(usageCountersManager.confirm).toHaveBeenCalledWith(
        [dedupeKey('vpn', hashEventId('event-1'))],
        {
          increments: [{ key: counterKey, field: 'd7', amount: 5 }],
          expiries: [
            {
              key: counterKey,
              expireAtSeconds: dayCountersExpireAt(
                new Date(WIRE_EVENT.timestamp),
                { kind: 'calendar', period: 'monthly' }
              ),
            },
          ],
          sessionEvents: [],
        }
      );
    });

    it('looks each slug in the batch up once', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      service.handleMessage(messageFor({ ...WIRE_EVENT, id: 'event-2' }));
      await service.flushNow();

      expect(meteringConfigurationManager.getMeterBySlug.mock.calls).toEqual([
        ['tokens'],
      ]);
    });

    it('inserts events for a slug that is no longer configured without counting them', async () => {
      meteringConfigurationManager.getMeterBySlug.mockResolvedValue(null);
      const message = messageFor(WIRE_EVENT);

      service.handleMessage(message);
      await service.flushNow();

      expect(meteringEventsManager.insertEvents).toHaveBeenCalledTimes(1);
      expect(usageCountersManager.confirm).toHaveBeenCalledWith(
        [dedupeKey('vpn', hashEventId('event-1'))],
        { increments: [], expiries: [], sessionEvents: [] }
      );
      expect(message.ack).toHaveBeenCalled();
    });

    it('still acks the batch when confirming the claims fails', async () => {
      usageCountersManager.confirm.mockRejectedValue(
        new UsageCountersError('confirm', new Error('connection closed'))
      );
      const message = messageFor(WIRE_EVENT);

      service.handleMessage(message);
      await service.flushNow();

      expect(message.ack).toHaveBeenCalled();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.confirm_error'
      );
    });

    it('counts only inserted survivors in the inserted metric', async () => {
      usageCountersManager.claim.mockResolvedValue(['claimed', 'duplicate']);

      service.handleMessage(messageFor(WIRE_EVENT));
      service.handleMessage(messageFor({ ...WIRE_EVENT, id: 'event-2' }));
      await service.flushNow();

      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.inserted',
        1,
        { clientId: 'vpn', slug: 'tokens' }
      );
    });

    it('adds the inserted amounts to the amount metric', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      service.handleMessage(
        messageFor({ ...WIRE_EVENT, id: 'event-2', amount: 7 })
      );
      await service.flushNow();

      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.inserted_amount',
        12,
        { clientId: 'vpn', slug: 'tokens' }
      );
    });

    it('leaves the amount of a duplicate out of the amount metric', async () => {
      usageCountersManager.claim.mockResolvedValue(['claimed', 'duplicate']);

      service.handleMessage(messageFor(WIRE_EVENT));
      service.handleMessage(
        messageFor({ ...WIRE_EVENT, id: 'event-2', amount: 7 })
      );
      await service.flushNow();

      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.inserted_amount',
        5,
        { clientId: 'vpn', slug: 'tokens' }
      );
    });

    it('reports inserted counts and amounts separately for each slug', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      service.handleMessage(
        messageFor({
          ...WIRE_EVENT,
          id: 'event-2',
          slug: 'bandwidth',
          amount: 7,
        })
      );
      await service.flushNow();

      expect(statsd.increment.mock.calls).toEqual([
        ['metering.consumer.received'],
        ['metering.consumer.received'],
        ['metering.consumer.inserted', 1, { clientId: 'vpn', slug: 'tokens' }],
        [
          'metering.consumer.inserted_amount',
          5,
          { clientId: 'vpn', slug: 'tokens' },
        ],
        [
          'metering.consumer.inserted',
          1,
          { clientId: 'vpn', slug: 'bandwidth' },
        ],
        [
          'metering.consumer.inserted_amount',
          7,
          { clientId: 'vpn', slug: 'bandwidth' },
        ],
      ]);
    });

    it('reports inserted counts and amounts separately for each client of a slug', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      service.handleMessage(
        messageFor({
          ...WIRE_EVENT,
          id: 'event-2',
          clientId: 'relay',
          amount: 7,
        })
      );
      await service.flushNow();

      expect(statsd.increment.mock.calls).toEqual([
        ['metering.consumer.received'],
        ['metering.consumer.received'],
        ['metering.consumer.inserted', 1, { clientId: 'vpn', slug: 'tokens' }],
        [
          'metering.consumer.inserted_amount',
          5,
          { clientId: 'vpn', slug: 'tokens' },
        ],
        [
          'metering.consumer.inserted',
          1,
          { clientId: 'relay', slug: 'tokens' },
        ],
        [
          'metering.consumer.inserted_amount',
          7,
          { clientId: 'relay', slug: 'tokens' },
        ],
      ]);
    });
  });

  describe('ingest gate', () => {
    it('nacks the batch without claiming while ingest is not allowed', async () => {
      usageCountersManager.isIngestAllowed.mockResolvedValue(false);
      const message = messageFor(WIRE_EVENT);

      service.handleMessage(message);
      await service.flushNow();

      expect(usageCountersManager.claim).not.toHaveBeenCalled();
      expect(message.nack).toHaveBeenCalled();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.paused',
        1
      );
    });

    it('nacks the batch when the ingest check fails', async () => {
      usageCountersManager.isIngestAllowed.mockRejectedValue(
        new UsageCountersError(
          'isIngestAllowed',
          new Error('connection closed')
        )
      );
      const message = messageFor(WIRE_EVENT);

      service.handleMessage(message);
      await service.flushNow();

      expect(usageCountersManager.claim).not.toHaveBeenCalled();
      expect(message.nack).toHaveBeenCalled();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.dedupe_error'
      );
    });
  });

  describe('meter lookup failure', () => {
    beforeEach(() => {
      meteringConfigurationManager.getMeterBySlug.mockRejectedValue(
        new Error('strapi down')
      );
    });

    it('releases the claims and nacks the batch before inserting', async () => {
      const message = messageFor(WIRE_EVENT);

      service.handleMessage(message);
      await service.flushNow();

      expect(meteringEventsManager.insertEvents).not.toHaveBeenCalled();
      expect(usageCountersManager.release).toHaveBeenCalledWith([
        dedupeKey('vpn', hashEventId('event-1')),
      ]);
      expect(message.nack).toHaveBeenCalled();
    });

    it('counts the failure in its own metric', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      await service.flushNow();

      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.meter_error'
      );
    });
  });

  describe('meter lookup failure for one slug', () => {
    const OTHER_EVENT = { ...WIRE_EVENT, id: 'event-2', slug: 'images' };

    beforeEach(() => {
      meteringConfigurationManager.getMeterBySlug.mockImplementation(
        (slug: string) =>
          slug === WIRE_EVENT.slug
            ? Promise.reject(new Error('invalid meter'))
            : Promise.resolve(monthlyMeter(slug))
      );
    });

    it('releases the claims and nacks only the messages of the failed slug', async () => {
      const failed = messageFor(WIRE_EVENT);
      const other = messageFor(OTHER_EVENT);

      service.handleMessage(failed);
      service.handleMessage(other);
      await service.flushNow();

      expect(usageCountersManager.release).toHaveBeenCalledWith([
        dedupeKey('vpn', hashEventId('event-1')),
      ]);
      expect(failed.nack).toHaveBeenCalled();
      expect(failed.ack).not.toHaveBeenCalled();
    });

    it('inserts and acks the messages of the other slugs', async () => {
      const failed = messageFor(WIRE_EVENT);
      const other = messageFor(OTHER_EVENT);

      service.handleMessage(failed);
      service.handleMessage(other);
      await service.flushNow();

      expect(
        meteringEventsManager.insertEvents.mock.calls[0][0].map(
          (event) => event.slug
        )
      ).toEqual(['images']);
      expect(other.ack).toHaveBeenCalled();
      expect(other.nack).not.toHaveBeenCalled();
    });
  });

  describe('session meters', () => {
    beforeEach(() => {
      meteringConfigurationManager.getMeterBySlug.mockImplementation(
        (slug: string) => Promise.resolve(sessionMeter(slug))
      );
    });

    it('sends session events to the confirm transaction', async () => {
      service.handleMessage(messageFor(WIRE_EVENT));
      await service.flushNow();

      expect(usageCountersManager.confirm.mock.calls[0][1]).toEqual({
        increments: [],
        expiries: [],
        sessionEvents: [
          {
            key: sessionKey(WIRE_EVENT),
            eventTimeMs: Date.parse(WIRE_EVENT.timestamp),
            amount: 5,
            durationMs: SESSION_DURATION_MS,
          },
        ],
      });
    });
  });

  describe('insert failure', () => {
    it('reports no inserted count or amount when the insert fails', async () => {
      meteringEventsManager.insertEvents.mockRejectedValue(
        new ClickHouseError('insert', new Error('down'))
      );

      service.handleMessage(messageFor(WIRE_EVENT));
      await service.flushNow();

      const metrics = statsd.increment.mock.calls.map(([metric]) => metric);
      expect(metrics).not.toContain('metering.consumer.inserted');
      expect(metrics).not.toContain('metering.consumer.inserted_amount');
    });

    it('releases the claims and nacks the batch when the insert fails', async () => {
      meteringEventsManager.insertEvents.mockRejectedValue(
        new ClickHouseError('insert', new Error('down'))
      );
      const message = messageFor(WIRE_EVENT);

      service.handleMessage(message);
      await service.flushNow();

      expect(usageCountersManager.release).toHaveBeenCalledWith([
        dedupeKey('vpn', hashEventId('event-1')),
      ]);
      expect(message.nack).toHaveBeenCalled();
      expect(message.ack).not.toHaveBeenCalled();
      expect(statsd.increment).toHaveBeenCalledWith(
        'metering.consumer.insert_error'
      );
    });

    it('still acks duplicates when the insert of fresh events fails', async () => {
      usageCountersManager.claim.mockResolvedValue(['claimed', 'duplicate']);
      meteringEventsManager.insertEvents.mockRejectedValue(
        new ClickHouseError('insert', new Error('down'))
      );
      const fresh = messageFor(WIRE_EVENT);
      const duplicate = messageFor({ ...WIRE_EVENT, id: 'event-2' });

      service.handleMessage(fresh);
      service.handleMessage(duplicate);
      await service.flushNow();

      expect(fresh.nack).toHaveBeenCalled();
      expect(duplicate.ack).toHaveBeenCalled();
    });

    it('nacks the batch even when releasing the claims also fails', async () => {
      meteringEventsManager.insertEvents.mockRejectedValue(
        new ClickHouseError('insert', new Error('down'))
      );
      usageCountersManager.release.mockRejectedValue(
        new UsageCountersError('release', new Error('connection closed'))
      );
      const message = messageFor(WIRE_EVENT);

      service.handleMessage(message);
      await service.flushNow();

      expect(message.nack).toHaveBeenCalled();
    });
  });

  describe('flushNow', () => {
    it('does nothing when the buffer is empty', async () => {
      await service.flushNow();

      expect(meteringEventsManager.insertEvents).not.toHaveBeenCalled();
    });
  });

  describe('beforeApplicationShutdown', () => {
    it('does nothing when the consumer never started', async () => {
      await service.beforeApplicationShutdown();

      expect(subscriptionClose).not.toHaveBeenCalled();
    });

    it('closes the subscription and flushes buffered messages', async () => {
      await build({ consumerBatchSize: 100 });
      service.onApplicationBootstrap();
      const message = messageFor(WIRE_EVENT);
      service.handleMessage(message);

      await service.beforeApplicationShutdown();

      expect(removeAllListeners).toHaveBeenCalled();
      expect(subscriptionClose).toHaveBeenCalled();
      expect(meteringEventsManager.insertEvents).toHaveBeenCalledTimes(1);
      expect(message.ack).toHaveBeenCalled();
    });
  });
});
