/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MeteringWindow } from '@entitlements/shared/cms';

import { buildCounterWrites } from './buildCounterWrites';
import { dayCountersExpireAt, hourCountersExpireAt } from './counterExpiry';

const MONTHLY: MeteringWindow = { kind: 'calendar', period: 'monthly' };
const SLIDING_DURATION_MS = 24 * 60 * 60 * 1000;
const SLIDING: MeteringWindow = {
  kind: 'sliding',
  durationMs: SLIDING_DURATION_MS,
};
const SESSION_DURATION_MS = 5 * 60 * 60 * 1000;
const SESSION: MeteringWindow = {
  kind: 'session',
  durationMs: SESSION_DURATION_MS,
};

function event(
  slug: string,
  amount: number,
  eventTime: string,
  subject = 'user-1'
) {
  return {
    clientId: 'vpn',
    slug,
    subject,
    amount,
    eventTime: new Date(eventTime),
  };
}

const MONTHLY_KEY = 'usage-days:["vpn","monthly","user-1","2026-11"]';

describe('buildCounterWrites', () => {
  it('adds a calendar event to the day field of its month hash', () => {
    const writes = buildCounterWrites(
      [event('monthly', 5, '2026-11-05T13:37:00.000Z')],
      new Map([['monthly', MONTHLY]])
    );

    expect(writes).toEqual({
      increments: [{ key: MONTHLY_KEY, field: 'd5', amount: 5 }],
      expiries: [
        {
          key: MONTHLY_KEY,
          expireAtSeconds: dayCountersExpireAt(
            new Date('2026-11-05T13:37:00.000Z'),
            MONTHLY
          ),
        },
      ],
      sessionEvents: [],
    });
  });

  it('sums events for the same subject and day into one increment', () => {
    const writes = buildCounterWrites(
      [
        event('monthly', 5, '2026-11-05T01:00:00.000Z'),
        event('monthly', 7, '2026-11-05T23:00:00.000Z'),
      ],
      new Map([['monthly', MONTHLY]])
    );

    expect(writes.increments).toEqual([
      { key: MONTHLY_KEY, field: 'd5', amount: 12 },
    ]);
    expect(writes.expiries).toHaveLength(1);
  });

  it('keeps different days of one month as separate fields of one hash', () => {
    const writes = buildCounterWrites(
      [
        event('monthly', 5, '2026-11-05T01:00:00.000Z'),
        event('monthly', 7, '2026-11-06T01:00:00.000Z'),
      ],
      new Map([['monthly', MONTHLY]])
    );

    expect(writes.increments).toEqual([
      { key: MONTHLY_KEY, field: 'd5', amount: 5 },
      { key: MONTHLY_KEY, field: 'd6', amount: 7 },
    ]);
    expect(writes.expiries).toHaveLength(1);
  });

  it('adds a sliding event to both its day field and its hour field', () => {
    const writes = buildCounterWrites(
      [event('sliding', 5, '2026-11-05T13:37:00.000Z')],
      new Map([['sliding', SLIDING]])
    );

    expect(writes.increments).toEqual([
      {
        key: 'usage-days:["vpn","sliding","user-1","2026-11"]',
        field: 'd5',
        amount: 5,
      },
      {
        key: 'usage-hours:["vpn","sliding","user-1","2026-11-05"]',
        field: 'h13',
        amount: 5,
      },
    ]);
    expect(writes.expiries).toContainEqual({
      key: 'usage-hours:["vpn","sliding","user-1","2026-11-05"]',
      expireAtSeconds: hourCountersExpireAt(
        new Date('2026-11-05T13:37:00.000Z'),
        SLIDING_DURATION_MS
      ),
    });
  });

  it('sends session events to the session script instead of the counters', () => {
    const writes = buildCounterWrites(
      [event('session', 5, '2026-11-05T13:37:00.000Z')],
      new Map([['session', SESSION]])
    );

    expect(writes).toEqual({
      increments: [],
      expiries: [],
      sessionEvents: [
        {
          key: 'session:["vpn","session","user-1"]',
          eventTimeMs: Date.parse('2026-11-05T13:37:00.000Z'),
          amount: 5,
          durationMs: SESSION_DURATION_MS,
        },
      ],
    });
  });

  it('orders session events by event time so the script sees them in order', () => {
    const writes = buildCounterWrites(
      [
        event('session', 1, '2026-11-05T13:40:00.000Z'),
        event('session', 2, '2026-11-05T13:30:00.000Z'),
      ],
      new Map([['session', SESSION]])
    );

    expect(writes.sessionEvents.map((write) => write.amount)).toEqual([2, 1]);
  });

  it('writes nothing for an event whose meter is not configured', () => {
    expect(
      buildCounterWrites(
        [event('removed', 5, '2026-11-05T13:37:00.000Z')],
        new Map()
      )
    ).toEqual({ increments: [], expiries: [], sessionEvents: [] });
  });
});
