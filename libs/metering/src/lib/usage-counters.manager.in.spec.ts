/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'reflect-metadata';

import Redis from 'ioredis';

import type { MeteringWindow } from '@entitlements/shared/cms';

import {
  MockMeteringRedisConfig,
  MeteringRedisConfig,
} from './metering-redis.config';
import type { CounterWrites, SessionEventWrite } from './metering.types';
import { UsageCountersManager } from './usage-counters.manager';
import { buildCounterWrites } from './utils/buildCounterWrites';
import { parseRedisRunId } from './utils/parseRedisRunId';
import { resolveWindow } from './utils/resolveWindow';

const REDIS_HOST = process.env['REDIS_TEST_HOST'] ?? 'localhost';
const REDIS_PORT = Number(process.env['REDIS_TEST_PORT'] ?? 6379);
const KEY_PREFIX = 'test-metering:counters-in-spec:';

const KEY = { clientId: 'vpn', slug: 'chat', subject: 'user-1' };
const HOUR_MS = 60 * 60 * 1000;

const NO_COUNTER_WRITES: CounterWrites = {
  increments: [],
  expiries: [],
  sessionEvents: [],
};

const SESSION_KEY = 'session:["vpn","chat","user-1"]';
const SESSION_DURATION_MS = 5 * HOUR_MS;
const SESSION_START_MS = Date.now() - HOUR_MS;

function sessionEvent(offsetMs: number, amount: number): SessionEventWrite {
  return {
    key: SESSION_KEY,
    eventTimeMs: SESSION_START_MS + offsetMs,
    amount,
    durationMs: SESSION_DURATION_MS,
  };
}

function sessionWrites(...events: SessionEventWrite[]): CounterWrites {
  return { ...NO_COUNTER_WRITES, sessionEvents: events };
}

const CLAIMS_KEY_PREFIX = 'test-metering:dedupe:';

const CONFIG: MeteringRedisConfig = {
  ...MockMeteringRedisConfig,
  host: REDIS_HOST,
  port: REDIS_PORT,
  keyPrefix: CLAIMS_KEY_PREFIX,
};

describe('usage counters written at ingest and read by the API, against a real Redis', () => {
  let prefixed: Redis.Redis;
  let raw: Redis.Redis;
  let countersManager: UsageCountersManager;
  let eventCount = 0;

  async function ingest(
    window: MeteringWindow,
    amount: number,
    eventTime: string
  ): Promise<void> {
    eventCount += 1;
    await countersManager.confirm(
      [`dedupe:${eventCount}`],
      buildCounterWrites(
        [{ ...KEY, amount, eventTime: new Date(eventTime) }],
        new Map([[KEY.slug, window]])
      )
    );
  }

  async function deleteTestKeys(): Promise<void> {
    const keys = await raw.keys(`${KEY_PREFIX}*`);
    if (keys.length > 0) {
      await raw.del(...keys);
    }
  }

  beforeAll(() => {
    prefixed = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      keyPrefix: KEY_PREFIX,
    });
    raw = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    countersManager = new UsageCountersManager(
      MockMeteringRedisConfig,
      prefixed
    );
  });

  beforeEach(async () => {
    await deleteTestKeys();
    await prefixed.set('redis-fully-populated', 'now');
  });

  afterAll(async () => {
    await deleteTestKeys();
    await prefixed.quit();
    await raw.quit();
  });

  it.each([
    { kind: 'calendar', period: 'daily' },
    { kind: 'calendar', period: 'weekly' },
    { kind: 'calendar', period: 'monthly' },
  ] satisfies MeteringWindow[])(
    'counts a $period window from its own days only',
    async (window) => {
      const now = new Date();
      const { windowStart } = resolveWindow(window, now);
      await ingest(
        window,
        100,
        new Date(windowStart.getTime() - 1000).toISOString()
      );
      await ingest(window, 5, windowStart.toISOString());
      await ingest(window, 7, now.toISOString());

      const result = await countersManager.findWindowUsage(KEY, window, now);

      expect(result?.usage).toBe(12);
    }
  );

  it('counts a sliding window from hour buckets at both edges and day buckets between', async () => {
    const window: MeteringWindow = {
      kind: 'sliding',
      durationMs: 50 * HOUR_MS,
    };
    const now = new Date();
    const { windowStart, windowEnd } = resolveWindow(window, now);
    const at = (offsetMs: number) =>
      new Date(windowStart.getTime() + offsetMs).toISOString();
    await ingest(window, 100, at(-60_000));
    await ingest(window, 1, at(0));
    await ingest(window, 2, at(20 * HOUR_MS));
    await ingest(window, 3, now.toISOString());

    const result = await countersManager.findWindowUsage(KEY, window, now);

    expect(result).toEqual({ usage: 6, windowStart, windowEnd });
  });

  it('counts a session from its first event', async () => {
    const window: MeteringWindow = { kind: 'session', durationMs: 5 * HOUR_MS };
    const now = new Date();
    const sessionStart = new Date(now.getTime() - 2 * HOUR_MS);
    await ingest(window, 3, sessionStart.toISOString());
    await ingest(window, 4, new Date(now.getTime() - HOUR_MS).toISOString());

    const result = await countersManager.findWindowUsage(KEY, window, now);

    expect(result).toEqual({
      usage: 7,
      windowStart: sessionStart,
      windowEnd: new Date(sessionStart.getTime() + 5 * HOUR_MS),
    });
  });

  it('returns undefined once Redis is no longer fully populated', async () => {
    const window: MeteringWindow = { kind: 'calendar', period: 'monthly' };
    await ingest(window, 5, new Date().toISOString());
    await prefixed.del('redis-fully-populated');

    await expect(
      countersManager.findWindowUsage(KEY, window, new Date())
    ).resolves.toBeUndefined();
  });
});

describe('UsageCountersManager claims and confirms against a real Redis', () => {
  let prefixed: Redis.Redis;
  let raw: Redis.Redis;
  let manager: UsageCountersManager;

  async function deleteTestKeys(): Promise<void> {
    const keys = await raw.keys(`${CLAIMS_KEY_PREFIX}*`);
    if (keys.length > 0) {
      await raw.del(...keys);
    }
  }

  beforeAll(() => {
    prefixed = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      keyPrefix: CLAIMS_KEY_PREFIX,
    });
    raw = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
    manager = new UsageCountersManager(CONFIG, prefixed);
  });

  beforeEach(async () => {
    await deleteTestKeys();
  });

  afterAll(async () => {
    await deleteTestKeys();
    await prefixed.quit();
    await raw.quit();
  });

  it('claims a key the first time it is seen', async () => {
    await expect(manager.claim(['vpn:e1'])).resolves.toEqual(['claimed']);
  });

  it('reports pending while an earlier claim has not been confirmed', async () => {
    await manager.claim(['vpn:e1']);

    await expect(manager.claim(['vpn:e1'])).resolves.toEqual(['pending']);
  });

  it('reports a duplicate once the claim has been confirmed', async () => {
    await manager.claim(['vpn:e1']);
    await manager.confirm(['vpn:e1'], NO_COUNTER_WRITES);

    await expect(manager.claim(['vpn:e1'])).resolves.toEqual(['duplicate']);
  });

  it('makes a released key claimable again', async () => {
    await manager.claim(['vpn:e1']);
    await manager.release(['vpn:e1']);

    await expect(manager.claim(['vpn:e1'])).resolves.toEqual(['claimed']);
  });

  it('treats the same event id under two clients as two events', async () => {
    await expect(manager.claim(['vpn:e1', 'relay:e1'])).resolves.toEqual([
      'claimed',
      'claimed',
    ]);
  });

  it('holds an unconfirmed claim only for the short claim TTL', async () => {
    await manager.claim(['vpn:e1']);

    const ttlMs = await raw.pttl(`${CLAIMS_KEY_PREFIX}vpn:e1`);
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(CONFIG.claimTtlSeconds * 1000);
  });

  it('extends a confirmed claim to the full dedupe TTL', async () => {
    await manager.claim(['vpn:e1']);
    await manager.confirm(['vpn:e1'], NO_COUNTER_WRITES);

    const ttlMs = await raw.pttl(`${CLAIMS_KEY_PREFIX}vpn:e1`);
    expect(ttlMs).toBeGreaterThan(CONFIG.claimTtlSeconds * 1000);
    expect(ttlMs).toBeLessThanOrEqual(CONFIG.dedupeTtlSeconds * 1000);
  });

  it('namespaces every key under the configured prefix', async () => {
    await manager.claim(['vpn:e1']);
    await expect(raw.get(`${CLAIMS_KEY_PREFIX}vpn:e1`)).resolves.toBe(
      'claimed'
    );

    await manager.confirm(['vpn:e1'], NO_COUNTER_WRITES);
    await expect(raw.get(`${CLAIMS_KEY_PREFIX}vpn:e1`)).resolves.toBe('stored');
  });

  describe('isIngestAllowed', () => {
    async function markFullyPopulated(runId: string): Promise<void> {
      await prefixed.set('redis-fully-populated', 'now');
      await prefixed.set('redis-run-id', runId);
    }

    async function currentRunId(): Promise<string> {
      const runId = parseRedisRunId(await raw.info('server'));
      if (runId === null) {
        throw new Error('INFO server did not include run_id');
      }
      return runId;
    }

    it('refuses ingest while Redis is not fully populated', async () => {
      await expect(manager.isIngestAllowed()).resolves.toBe(false);
    });

    it('allows ingest once Redis is fully populated under its current run id', async () => {
      await markFullyPopulated(await currentRunId());

      await expect(manager.isIngestAllowed()).resolves.toBe(true);
    });

    it('refuses ingest while it is paused', async () => {
      await markFullyPopulated(await currentRunId());
      await prefixed.set('ingest-paused', 'now');

      await expect(manager.isIngestAllowed()).resolves.toBe(false);
    });

    it('refuses ingest when the recorded run id is from another Redis run', async () => {
      await markFullyPopulated('old-run-id');

      await expect(manager.isIngestAllowed()).resolves.toBe(false);
    });
  });

  describe('counters', () => {
    const counterKey = 'usage-days:["vpn","chat","user-1","2026-11"]';
    const expireAtSeconds = Math.ceil(Date.now() / 1000) + 3600;

    function counterWrites(amount: number): CounterWrites {
      return {
        increments: [{ key: counterKey, field: 'd5', amount }],
        expiries: [{ key: counterKey, expireAtSeconds }],
        sessionEvents: [],
      };
    }

    it('adds each confirmed batch to the counter', async () => {
      await manager.confirm(['vpn:e1'], counterWrites(5));
      await manager.confirm(['vpn:e2'], counterWrites(7));

      await expect(prefixed.hget(counterKey, 'd5')).resolves.toBe('12');
    });

    it('sets the expiry of the counter hash', async () => {
      await manager.confirm(['vpn:e1'], counterWrites(5));

      await expect(prefixed.ttl(counterKey)).resolves.toBeGreaterThan(3500);
    });
  });

  describe('session script', () => {
    it('opens a session at the first event of a subject', async () => {
      await manager.confirm(['vpn:e1'], sessionWrites(sessionEvent(0, 3)));

      await expect(prefixed.hgetall(SESSION_KEY)).resolves.toEqual({
        start: String(SESSION_START_MS),
        usage: '3',
      });
    });

    it('adds a later event inside the session to its usage', async () => {
      await manager.confirm(['vpn:e1'], sessionWrites(sessionEvent(0, 3)));

      await manager.confirm(['vpn:e2'], sessionWrites(sessionEvent(60_000, 4)));

      await expect(prefixed.hgetall(SESSION_KEY)).resolves.toEqual({
        start: String(SESSION_START_MS),
        usage: '7',
      });
    });

    it('opens a new session for an event exactly at the end of the previous one', async () => {
      await manager.confirm(['vpn:e1'], sessionWrites(sessionEvent(0, 3)));

      await manager.confirm(
        ['vpn:e2'],
        sessionWrites(sessionEvent(SESSION_DURATION_MS, 4))
      );

      await expect(prefixed.hgetall(SESSION_KEY)).resolves.toEqual({
        start: String(SESSION_START_MS + SESSION_DURATION_MS),
        usage: '4',
      });
    });

    it('leaves out a late event from before the session start', async () => {
      await manager.confirm(['vpn:e1'], sessionWrites(sessionEvent(0, 3)));

      await manager.confirm(
        ['vpn:e2'],
        sessionWrites(sessionEvent(-60_000, 4))
      );

      await expect(prefixed.hgetall(SESSION_KEY)).resolves.toEqual({
        start: String(SESSION_START_MS),
        usage: '3',
      });
    });

    it('applies several events of one batch in order', async () => {
      await manager.confirm(
        ['vpn:e1', 'vpn:e2', 'vpn:e3'],
        sessionWrites(
          sessionEvent(0, 1),
          sessionEvent(60_000, 2),
          sessionEvent(SESSION_DURATION_MS + 1, 5)
        )
      );

      await expect(prefixed.hgetall(SESSION_KEY)).resolves.toEqual({
        start: String(SESSION_START_MS + SESSION_DURATION_MS + 1),
        usage: '5',
      });
    });

    it('expires the session an hour after it ends', async () => {
      await manager.confirm(['vpn:e1'], sessionWrites(sessionEvent(0, 3)));

      const expiresAtMs = Date.now() + (await prefixed.pttl(SESSION_KEY));
      expect(expiresAtMs).toBeGreaterThan(
        SESSION_START_MS + SESSION_DURATION_MS + 59 * 60 * 1000
      );
      expect(expiresAtMs).toBeLessThanOrEqual(
        SESSION_START_MS + SESSION_DURATION_MS + 60 * 60 * 1000
      );
    });
  });
});
