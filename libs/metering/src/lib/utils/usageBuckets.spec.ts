/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  counterReadsForBuckets,
  dayField,
  dayOf,
  hourField,
  monthOf,
  splitIntoBuckets,
  startOfNextUtcMonth,
  startOfUtcDay,
} from './usageBuckets';

const KEY = { clientId: 'vpn', slug: 'chat', subject: 'user-1' };

function isoList(dates: Date[]): string[] {
  return dates.map((date) => date.toISOString());
}

describe('usageBuckets', () => {
  describe('field and period names', () => {
    const time = new Date('2026-11-05T13:37:00.000Z');

    it('names the month of a time', () => {
      expect(monthOf(time)).toBe('2026-11');
    });

    it('names the day of a time', () => {
      expect(dayOf(time)).toBe('2026-11-05');
    });

    it('names the day field by day of month without padding', () => {
      expect(dayField(time)).toBe('d5');
    });

    it('names the hour field by hour of day without padding', () => {
      expect(hourField(new Date('2026-11-05T03:00:00.000Z'))).toBe('h3');
    });

    it('starts the day at UTC midnight', () => {
      expect(startOfUtcDay(time).toISOString()).toBe(
        '2026-11-05T00:00:00.000Z'
      );
    });

    it('rolls the next month over the year end', () => {
      expect(
        startOfNextUtcMonth(new Date('2026-12-31T23:00:00.000Z')).toISOString()
      ).toBe('2027-01-01T00:00:00.000Z');
    });
  });

  describe('splitIntoBuckets', () => {
    it('uses whole days only for a midnight-aligned window', () => {
      const buckets = splitIntoBuckets(
        new Date('2026-11-01T00:00:00.000Z'),
        new Date('2026-11-04T00:00:00.000Z')
      );

      expect(isoList(buckets.days)).toEqual([
        '2026-11-01T00:00:00.000Z',
        '2026-11-02T00:00:00.000Z',
        '2026-11-03T00:00:00.000Z',
      ]);
      expect(buckets.hours).toEqual([]);
    });

    it('uses hours only for a window inside one day', () => {
      const buckets = splitIntoBuckets(
        new Date('2026-11-05T09:00:00.000Z'),
        new Date('2026-11-05T12:00:00.000Z')
      );

      expect(buckets.days).toEqual([]);
      expect(isoList(buckets.hours)).toEqual([
        '2026-11-05T09:00:00.000Z',
        '2026-11-05T10:00:00.000Z',
        '2026-11-05T11:00:00.000Z',
      ]);
    });

    it('uses hours for both partial days and days in between', () => {
      const buckets = splitIntoBuckets(
        new Date('2026-11-03T22:00:00.000Z'),
        new Date('2026-11-06T02:00:00.000Z')
      );

      expect(isoList(buckets.days)).toEqual([
        '2026-11-04T00:00:00.000Z',
        '2026-11-05T00:00:00.000Z',
      ]);
      expect(isoList(buckets.hours)).toEqual([
        '2026-11-03T22:00:00.000Z',
        '2026-11-03T23:00:00.000Z',
        '2026-11-06T00:00:00.000Z',
        '2026-11-06T01:00:00.000Z',
      ]);
    });

    it('uses hours only for a window that crosses one midnight without a whole day', () => {
      const buckets = splitIntoBuckets(
        new Date('2026-11-05T22:00:00.000Z'),
        new Date('2026-11-06T01:00:00.000Z')
      );

      expect(buckets.days).toEqual([]);
      expect(buckets.hours).toHaveLength(3);
    });

    it('returns no buckets for an empty window', () => {
      const time = new Date('2026-11-05T22:00:00.000Z');

      expect(splitIntoBuckets(time, time)).toEqual({ days: [], hours: [] });
    });
  });

  describe('counterReadsForBuckets', () => {
    it('reads the days of one month from one hash', () => {
      const reads = counterReadsForBuckets(
        KEY,
        splitIntoBuckets(
          new Date('2026-11-01T00:00:00.000Z'),
          new Date('2026-11-03T00:00:00.000Z')
        )
      );

      expect(reads).toEqual([
        {
          key: 'usage-days:["vpn","chat","user-1","2026-11"]',
          fields: ['d1', 'd2'],
        },
      ]);
    });

    it('reads a week that crosses a month from two hashes', () => {
      const reads = counterReadsForBuckets(
        KEY,
        splitIntoBuckets(
          new Date('2026-11-30T00:00:00.000Z'),
          new Date('2026-12-02T00:00:00.000Z')
        )
      );

      expect(reads).toEqual([
        {
          key: 'usage-days:["vpn","chat","user-1","2026-11"]',
          fields: ['d30'],
        },
        {
          key: 'usage-days:["vpn","chat","user-1","2026-12"]',
          fields: ['d1'],
        },
      ]);
    });

    it('reads hours from the hour hash of their day', () => {
      const reads = counterReadsForBuckets(
        KEY,
        splitIntoBuckets(
          new Date('2026-11-05T22:00:00.000Z'),
          new Date('2026-11-06T01:00:00.000Z')
        )
      );

      expect(reads).toEqual([
        {
          key: 'usage-hours:["vpn","chat","user-1","2026-11-05"]',
          fields: ['h22', 'h23'],
        },
        {
          key: 'usage-hours:["vpn","chat","user-1","2026-11-06"]',
          fields: ['h0'],
        },
      ]);
    });
  });
});
