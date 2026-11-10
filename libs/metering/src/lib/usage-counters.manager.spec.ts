/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Test } from '@nestjs/testing';

import {
  recordingRedisPipeline,
  rejectingRedisPipeline,
  type RecordedRedisCommand,
} from '../testing';
import {
  MockMeteringRedisConfig,
  MeteringRedisConfig,
} from './metering-redis.config';
import { MeteringRedisClient } from './metering-redis.provider';
import { UsageCountersError } from './metering.error';
import type { CounterWrites, MeteringRedis } from './metering.types';
import { UsageCountersManager } from './usage-counters.manager';

const KEY = { clientId: 'vpn', slug: 'chat', subject: 'user-1' };
const NOW = new Date('2026-11-05T13:37:00.000Z');
const POPULATED = '2026-11-05T00:00:00.000Z';
const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;
const NO_COUNTER_WRITES: CounterWrites = {
  increments: [],
  expiries: [],
  sessionEvents: [],
};

describe('UsageCountersManager', () => {
  let manager: UsageCountersManager;
  let redis: jest.Mocked<
    Pick<
      MeteringRedis,
      'pipeline' | 'multi' | 'del' | 'info' | 'quit' | 'disconnect'
    >
  >;
  let commands: RecordedRedisCommand[];

  function replyWith(replies: Array<[Error | null, unknown]>) {
    redis.pipeline.mockReturnValueOnce(
      recordingRedisPipeline(replies, commands)
    );
  }

  function replyToMultiWith(replies: Array<[Error | null, unknown]>) {
    redis.multi.mockReturnValueOnce(recordingRedisPipeline(replies, commands));
  }

  beforeEach(async () => {
    commands = [];
    redis = {
      pipeline: jest.fn(),
      multi: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      info: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsageCountersManager,
        { provide: MeteringRedisConfig, useValue: MockMeteringRedisConfig },
        { provide: MeteringRedisClient, useValue: redis },
      ],
    }).compile();

    manager = moduleRef.get(UsageCountersManager);
  });

  describe('findWindowUsage', () => {
    describe('calendar windows', () => {
      it('sums the day fields of the month', async () => {
        replyWith([
          [null, POPULATED],
          [null, ['3', null, '4']],
        ]);

        await expect(
          manager.findWindowUsage(
            KEY,
            { kind: 'calendar', period: 'monthly' },
            NOW
          )
        ).resolves.toEqual({
          usage: 7,
          windowStart: new Date('2026-11-01T00:00:00.000Z'),
          windowEnd: new Date('2026-12-01T00:00:00.000Z'),
        });
      });

      it('reads the readiness marker and every day of the month in one round trip', async () => {
        replyWith([
          [null, POPULATED],
          [null, []],
        ]);

        await manager.findWindowUsage(
          KEY,
          { kind: 'calendar', period: 'monthly' },
          NOW
        );

        expect(redis.pipeline).toHaveBeenCalledTimes(1);
        expect(commands[0]).toEqual({
          command: 'get',
          args: ['redis-fully-populated'],
        });
        expect(commands[1].command).toBe('hmget');
        expect(commands[1].args).toHaveLength(31);
        expect(commands[1].args.slice(0, 3)).toEqual([
          'usage-days:["vpn","chat","user-1","2026-11"]',
          'd1',
          'd2',
        ]);
      });

      it('returns zero usage for a subject with no counters', async () => {
        replyWith([
          [null, POPULATED],
          [null, [null, null]],
        ]);

        const result = await manager.findWindowUsage(
          KEY,
          { kind: 'calendar', period: 'daily' },
          NOW
        );

        expect(result?.usage).toBe(0);
      });

      it('returns undefined while Redis is not fully populated', async () => {
        replyWith([
          [null, null],
          [null, ['3']],
        ]);

        await expect(
          manager.findWindowUsage(
            KEY,
            { kind: 'calendar', period: 'daily' },
            NOW
          )
        ).resolves.toBeUndefined();
      });
    });

    describe('sliding windows', () => {
      it('sums the hour fields of the window', async () => {
        replyWith([
          [null, POPULATED],
          [null, ['1', '2', null, '4', '5']],
        ]);

        const result = await manager.findWindowUsage(
          KEY,
          { kind: 'sliding', durationMs: 5 * 60 * 60 * 1000 },
          NOW
        );

        expect(result).toEqual({
          usage: 12,
          windowStart: new Date('2026-11-05T09:00:00.000Z'),
          windowEnd: new Date('2026-11-05T14:00:00.000Z'),
        });
        expect(commands[1]).toEqual({
          command: 'hmget',
          args: [
            'usage-hours:["vpn","chat","user-1","2026-11-05"]',
            'h9',
            'h10',
            'h11',
            'h12',
            'h13',
          ],
        });
      });
    });

    describe('session windows', () => {
      it('returns the usage of an open session', async () => {
        const start = Date.parse('2026-11-05T12:00:00.000Z');
        replyWith([
          [null, POPULATED],
          [null, [String(start), '9']],
        ]);

        await expect(
          manager.findWindowUsage(
            KEY,
            { kind: 'session', durationMs: SESSION_DURATION_MS },
            NOW
          )
        ).resolves.toEqual({
          usage: 9,
          windowStart: new Date(start),
          windowEnd: new Date(start + SESSION_DURATION_MS),
        });
        expect(commands[1]).toEqual({
          command: 'hmget',
          args: ['session:["vpn","chat","user-1"]', 'start', 'usage'],
        });
      });

      it('returns an empty window starting now when the session has ended', async () => {
        const start = Date.parse('2026-11-05T06:00:00.000Z');
        replyWith([
          [null, POPULATED],
          [null, [String(start), '9']],
        ]);

        await expect(
          manager.findWindowUsage(
            KEY,
            { kind: 'session', durationMs: SESSION_DURATION_MS },
            NOW
          )
        ).resolves.toEqual({
          usage: 0,
          windowStart: NOW,
          windowEnd: new Date(NOW.getTime() + SESSION_DURATION_MS),
        });
      });

      it('returns an empty window starting now when the subject has no session', async () => {
        replyWith([
          [null, POPULATED],
          [null, [null, null]],
        ]);

        const result = await manager.findWindowUsage(
          KEY,
          { kind: 'session', durationMs: SESSION_DURATION_MS },
          NOW
        );

        expect(result?.usage).toBe(0);
        expect(result?.windowStart).toEqual(NOW);
      });

      it('returns undefined while Redis is not fully populated', async () => {
        replyWith([
          [null, null],
          [null, [null, null]],
        ]);

        await expect(
          manager.findWindowUsage(
            KEY,
            { kind: 'session', durationMs: SESSION_DURATION_MS },
            NOW
          )
        ).resolves.toBeUndefined();
      });
    });

    it('wraps a Redis failure in UsageCountersError', async () => {
      redis.pipeline.mockReturnValueOnce(
        rejectingRedisPipeline(new Error('timeout'))
      );

      await expect(
        manager.findWindowUsage(KEY, { kind: 'calendar', period: 'daily' }, NOW)
      ).rejects.toThrow(UsageCountersError);
    });
  });

  describe('findSessionStarts', () => {
    const meterKey = { clientId: 'vpn', slug: 'chat' };

    it('returns the counted start of each subject that has a session', async () => {
      const start = Date.parse('2026-11-05T12:00:00.000Z');
      replyWith([
        [null, [String(start)]],
        [null, [null]],
      ]);

      await expect(
        manager.findSessionStarts(meterKey, ['user-1', 'user-2'])
      ).resolves.toEqual(new Map([['user-1', new Date(start)]]));
      expect(commands).toEqual([
        {
          command: 'hmget',
          args: ['session:["vpn","chat","user-1"]', 'start'],
        },
        {
          command: 'hmget',
          args: ['session:["vpn","chat","user-2"]', 'start'],
        },
      ]);
    });

    it('makes no Redis call for no subjects', async () => {
      await expect(manager.findSessionStarts(meterKey, [])).resolves.toEqual(
        new Map()
      );
      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('wraps a Redis failure in UsageCountersError', async () => {
      redis.pipeline.mockReturnValueOnce(
        rejectingRedisPipeline(new Error('timeout'))
      );

      await expect(
        manager.findSessionStarts(meterKey, ['user-1'])
      ).rejects.toThrow(UsageCountersError);
    });
  });

  describe('isIngestAllowed', () => {
    const RUN_ID = 'abc123';

    beforeEach(() => {
      redis.info.mockResolvedValue(`# Server\r\nrun_id:${RUN_ID}\r\n`);
    });

    it('allows ingest when Redis is fully populated, not paused, and has the recorded run id', async () => {
      replyWith([
        [null, POPULATED],
        [null, null],
        [null, RUN_ID],
      ]);

      await expect(manager.isIngestAllowed()).resolves.toBe(true);
    });

    it('refuses ingest while Redis is not fully populated', async () => {
      replyWith([
        [null, null],
        [null, null],
        [null, null],
      ]);

      await expect(manager.isIngestAllowed()).resolves.toBe(false);
    });

    it('refuses ingest while a refill has paused it', async () => {
      replyWith([
        [null, POPULATED],
        [null, '2026-05-15T12:01:00.000Z'],
        [null, RUN_ID],
      ]);

      await expect(manager.isIngestAllowed()).resolves.toBe(false);
    });

    it('refuses ingest when the Redis run id differs from the recorded one, as after a failover', async () => {
      replyWith([
        [null, POPULATED],
        [null, null],
        [null, 'old-run-id'],
      ]);

      await expect(manager.isIngestAllowed()).resolves.toBe(false);
    });

    it('refuses ingest when INFO server has no run id', async () => {
      redis.info.mockResolvedValue('# Server\r\nredis_version:7.2.17\r\n');
      replyWith([
        [null, POPULATED],
        [null, null],
        [null, RUN_ID],
      ]);

      await expect(manager.isIngestAllowed()).resolves.toBe(false);
    });

    it('reads the three markers in one round trip', async () => {
      replyWith([
        [null, null],
        [null, null],
        [null, null],
      ]);

      await manager.isIngestAllowed();

      expect(commands).toEqual([
        { command: 'get', args: ['redis-fully-populated'] },
        { command: 'get', args: ['ingest-paused'] },
        { command: 'get', args: ['redis-run-id'] },
      ]);
    });

    it('reads the run id from INFO server', async () => {
      replyWith([
        [null, null],
        [null, null],
        [null, null],
      ]);

      await manager.isIngestAllowed();

      expect(redis.info).toHaveBeenCalledWith('server');
    });

    it('wraps a rejected pipeline in UsageCountersError', async () => {
      redis.pipeline.mockReturnValueOnce(
        rejectingRedisPipeline(new Error('connection closed'))
      );

      await expect(manager.isIngestAllowed()).rejects.toThrow(
        UsageCountersError
      );
    });

    it('wraps a rejected INFO in UsageCountersError', async () => {
      redis.info.mockRejectedValue(new Error('connection closed'));
      replyWith([
        [null, POPULATED],
        [null, null],
        [null, RUN_ID],
      ]);

      await expect(manager.isIngestAllowed()).rejects.toThrow(
        UsageCountersError
      );
    });
  });

  describe('claim', () => {
    it('returns claimed for keys that were newly set', async () => {
      replyWith([
        [null, 'OK'],
        [null, 'claimed'],
        [null, 'OK'],
        [null, 'claimed'],
      ]);

      await expect(manager.claim(['vpn:e1', 'vpn:e2'])).resolves.toEqual([
        'claimed',
        'claimed',
      ]);
    });

    it('claims and reads each key in a single round trip', async () => {
      replyWith([
        [null, 'OK'],
        [null, 'claimed'],
      ]);

      await manager.claim(['vpn:e1']);

      expect(redis.pipeline).toHaveBeenCalledTimes(1);
      expect(commands).toEqual([
        {
          command: 'set',
          args: [
            'vpn:e1',
            'claimed',
            'EX',
            MockMeteringRedisConfig.claimTtlSeconds,
            'NX',
          ],
        },
        { command: 'get', args: ['vpn:e1'] },
      ]);
    });

    it('marks an already-stored key as a duplicate', async () => {
      replyWith([
        [null, null],
        [null, 'stored'],
      ]);

      await expect(manager.claim(['vpn:e1'])).resolves.toEqual(['duplicate']);
    });

    it('marks a key claimed by an unfinished batch as pending', async () => {
      replyWith([
        [null, null],
        [null, 'claimed'],
      ]);

      await expect(manager.claim(['vpn:e1'])).resolves.toEqual(['pending']);
    });

    it('keeps statuses aligned when claims and duplicates are mixed', async () => {
      replyWith([
        [null, null],
        [null, 'stored'],
        [null, 'OK'],
        [null, 'claimed'],
        [null, null],
        [null, 'claimed'],
      ]);

      await expect(
        manager.claim(['vpn:e1', 'vpn:e2', 'vpn:e3'])
      ).resolves.toEqual(['duplicate', 'claimed', 'pending']);
    });

    it('makes no redis calls for an empty key list', async () => {
      await expect(manager.claim([])).resolves.toEqual([]);

      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('wraps a rejected pipeline in UsageCountersError', async () => {
      redis.pipeline.mockReturnValueOnce(
        rejectingRedisPipeline(new Error('connection closed'))
      );

      await expect(manager.claim(['vpn:e1'])).rejects.toThrow(
        UsageCountersError
      );
    });

    it('wraps a per-command redis error in UsageCountersError', async () => {
      replyWith([[new Error('OOM'), null]]);

      await expect(manager.claim(['vpn:e1'])).rejects.toThrow(
        UsageCountersError
      );
    });
  });

  describe('confirm', () => {
    it('re-sets each key as stored with the full dedupe TTL', async () => {
      replyToMultiWith([[null, 'OK']]);

      await manager.confirm(['vpn:e1'], NO_COUNTER_WRITES);

      expect(commands).toEqual([
        {
          command: 'set',
          args: [
            'vpn:e1',
            'stored',
            'EX',
            MockMeteringRedisConfig.dedupeTtlSeconds,
          ],
        },
      ]);
    });

    it('writes the counters in the same transaction as the dedupe keys', async () => {
      replyToMultiWith([
        [null, 'OK'],
        [null, 7],
        [null, 1],
      ]);

      await manager.confirm(['vpn:e1'], {
        increments: [{ key: 'usage-days:k', field: 'd15', amount: 7 }],
        expiries: [{ key: 'usage-days:k', expireAtSeconds: 1_780_000_000 }],
        sessionEvents: [],
      });

      expect(redis.multi).toHaveBeenCalledTimes(1);
      expect(commands.slice(1)).toEqual([
        { command: 'hincrby', args: ['usage-days:k', 'd15', 7] },
        { command: 'expireat', args: ['usage-days:k', 1_780_000_000] },
      ]);
    });

    it('applies session events in one script call with keys first and three values per event', async () => {
      replyToMultiWith([
        [null, 'OK'],
        [null, 1],
      ]);

      await manager.confirm(['vpn:e1'], {
        ...NO_COUNTER_WRITES,
        sessionEvents: [
          {
            key: 'session:k',
            eventTimeMs: 1_779_000_000_000,
            amount: 3,
            durationMs: 18_000_000,
          },
        ],
      });

      const evalCommand = commands.find(({ command }) => command === 'eval');
      expect(evalCommand?.args.slice(1)).toEqual([
        1,
        'session:k',
        1_779_000_000_000,
        3,
        18_000_000,
      ]);
    });

    it('makes no redis calls for an empty key list', async () => {
      await manager.confirm([], NO_COUNTER_WRITES);

      expect(redis.multi).not.toHaveBeenCalled();
    });

    it('wraps a rejected transaction in UsageCountersError', async () => {
      redis.multi.mockReturnValueOnce(
        rejectingRedisPipeline(new Error('EXECABORT'))
      );

      await expect(
        manager.confirm(['vpn:e1'], NO_COUNTER_WRITES)
      ).rejects.toThrow(UsageCountersError);
    });
  });

  describe('release', () => {
    it('deletes the claimed keys', async () => {
      await manager.release(['vpn:e1', 'vpn:e2']);

      expect(redis.del).toHaveBeenCalledWith('vpn:e1', 'vpn:e2');
    });

    it('makes no redis calls for an empty key list', async () => {
      await manager.release([]);

      expect(redis.del).not.toHaveBeenCalled();
    });

    it('wraps a redis failure in UsageCountersError', async () => {
      redis.del.mockRejectedValue(new Error('connection closed'));

      await expect(manager.release(['vpn:e1'])).rejects.toThrow(
        UsageCountersError
      );
    });
  });

  describe('findRedisRunId', () => {
    it('reads the run id from INFO server', async () => {
      redis.info.mockResolvedValue(
        '# Server\r\nredis_version:7.2.17\r\nrun_id:abc123\r\ntcp_port:6379\r\n'
      );

      await expect(manager.findRedisRunId()).resolves.toBe('abc123');
      expect(redis.info).toHaveBeenCalledWith('server');
    });

    it('fails when INFO server has no run id', async () => {
      redis.info.mockResolvedValue('# Server\r\nredis_version:7.2.17\r\n');

      await expect(manager.findRedisRunId()).rejects.toThrow(
        UsageCountersError
      );
    });

    it('wraps a Redis failure in UsageCountersError', async () => {
      redis.info.mockRejectedValue(new Error('connection closed'));

      await expect(manager.findRedisRunId()).rejects.toThrow(
        UsageCountersError
      );
    });
  });

  describe('findPopulationState', () => {
    it('reads the markers', async () => {
      replyWith([
        [null, POPULATED],
        [null, 'abc123'],
        [null, '2026-11-05T13:36:00.000Z'],
      ]);

      await expect(manager.findPopulationState()).resolves.toEqual({
        fullyPopulated: true,
        runId: 'abc123',
        checkedAt: new Date('2026-11-05T13:36:00.000Z'),
      });
    });

    it('reports an empty Redis', async () => {
      replyWith([
        [null, null],
        [null, null],
        [null, null],
      ]);

      await expect(manager.findPopulationState()).resolves.toEqual({
        fullyPopulated: false,
        runId: null,
        checkedAt: null,
      });
    });
  });

  describe('findMeterWindowFingerprints', () => {
    it('maps each slug to its stored fingerprint', async () => {
      replyWith([
        [null, '{"kind":"calendar","period":"monthly"}'],
        [null, null],
      ]);

      await expect(
        manager.findMeterWindowFingerprints(['chat', 'new'])
      ).resolves.toEqual(
        new Map([
          ['chat', '{"kind":"calendar","period":"monthly"}'],
          ['new', null],
        ])
      );
    });

    it('makes no Redis call for no slugs', async () => {
      await expect(manager.findMeterWindowFingerprints([])).resolves.toEqual(
        new Map()
      );
      expect(redis.pipeline).not.toHaveBeenCalled();
    });
  });

  describe('state writes', () => {
    it('records meter window fingerprints without a TTL', async () => {
      replyWith([[null, 'OK']]);

      await manager.recordMeterWindowFingerprints(
        new Map([['chat', '{"kind":"calendar","period":"monthly"}']])
      );

      expect(commands).toEqual([
        {
          command: 'set',
          args: [
            'meter-window:["chat"]',
            '{"kind":"calendar","period":"monthly"}',
          ],
        },
      ]);
    });

    it('pauses ingest with a safety TTL', async () => {
      replyWith([[null, 'OK']]);

      await manager.pauseIngest(3600, NOW);

      expect(commands).toEqual([
        {
          command: 'set',
          args: ['ingest-paused', NOW.toISOString(), 'EX', 3600],
        },
      ]);
    });

    it('resumes ingest by deleting the pause marker', async () => {
      replyWith([[null, 1]]);

      await manager.resumeIngest();

      expect(commands).toEqual([{ command: 'del', args: ['ingest-paused'] }]);
    });

    it('marks Redis fully populated together with the run id and check time', async () => {
      replyWith([
        [null, 'OK'],
        [null, 'OK'],
        [null, 'OK'],
      ]);

      await manager.markFullyPopulated('abc123', NOW);

      expect(commands).toEqual([
        { command: 'set', args: ['redis-fully-populated', NOW.toISOString()] },
        { command: 'set', args: ['redis-run-id', 'abc123'] },
        { command: 'set', args: ['redis-checked-at', NOW.toISOString()] },
      ]);
    });

    it('records the run id and check time', async () => {
      replyWith([
        [null, 'OK'],
        [null, 'OK'],
      ]);

      await manager.markChecked('abc123', NOW);

      expect(commands).toEqual([
        { command: 'set', args: ['redis-run-id', 'abc123'] },
        { command: 'set', args: ['redis-checked-at', NOW.toISOString()] },
      ]);
    });

    it('wraps a Redis failure in UsageCountersError', async () => {
      redis.pipeline.mockReturnValueOnce(
        rejectingRedisPipeline(new Error('OOM'))
      );

      await expect(manager.resumeIngest()).rejects.toThrow(UsageCountersError);
    });
  });

  describe('rebuild writes', () => {
    it('sets counter totals and their expiries', async () => {
      replyWith([
        [null, 1],
        [null, 1],
      ]);

      await manager.writeCounterTotals(
        [{ key: 'usage-days:k', field: 'd5', amount: 12 }],
        [{ key: 'usage-days:k', expireAtSeconds: 1_780_000_000 }]
      );

      expect(commands).toEqual([
        { command: 'hset', args: ['usage-days:k', 'd5', 12] },
        { command: 'expireat', args: ['usage-days:k', 1_780_000_000] },
      ]);
    });

    it('sets session state and its expiry', async () => {
      replyWith([
        [null, 2],
        [null, 1],
      ]);

      await manager.writeSessions([
        {
          ...KEY,
          sessionStart: new Date('2026-11-05T12:00:00.000Z'),
          usage: 9,
          expireAtSeconds: 1_780_000_000,
        },
      ]);

      expect(commands).toEqual([
        {
          command: 'hset',
          args: [
            'session:["vpn","chat","user-1"]',
            'start',
            Date.parse('2026-11-05T12:00:00.000Z'),
            'usage',
            9,
          ],
        },
        {
          command: 'expireat',
          args: ['session:["vpn","chat","user-1"]', 1_780_000_000],
        },
      ]);
    });

    it('sets dedupe keys as stored with their remaining TTL', async () => {
      replyWith([[null, 'OK']]);

      await manager.writeDedupeKeys([
        { key: 'dedupe:["vpn","1"]', ttlSeconds: 500 },
      ]);

      expect(commands).toEqual([
        { command: 'set', args: ['dedupe:["vpn","1"]', 'stored', 'EX', 500] },
      ]);
    });

    it.each([
      [
        'counter totals',
        (m: UsageCountersManager) => m.writeCounterTotals([], []),
      ],
      ['sessions', (m: UsageCountersManager) => m.writeSessions([])],
      ['dedupe keys', (m: UsageCountersManager) => m.writeDedupeKeys([])],
    ])('makes no Redis call for empty %s', async (_, write) => {
      await write(manager);

      expect(redis.pipeline).not.toHaveBeenCalled();
    });
  });

  describe('onApplicationShutdown', () => {
    it('quits the redis connection', async () => {
      await manager.onApplicationShutdown();

      expect(redis.quit).toHaveBeenCalled();
    });

    it('force-disconnects when quit fails', async () => {
      redis.quit.mockRejectedValue(new Error('connection closed'));

      await manager.onApplicationShutdown();

      expect(redis.disconnect).toHaveBeenCalled();
    });
  });
});
