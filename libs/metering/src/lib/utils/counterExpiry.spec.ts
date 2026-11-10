/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  dayCountersExpireAt,
  hourCountersExpireAt,
  sessionExpireAt,
} from './counterExpiry';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function seconds(iso: string): number {
  return Date.parse(iso) / 1000;
}

describe('counterExpiry', () => {
  describe('dayCountersExpireAt', () => {
    it('keeps a calendar month hash eight days past the month end, for weekly windows that cross it', () => {
      expect(
        dayCountersExpireAt(new Date('2026-11-05T13:00:00.000Z'), {
          kind: 'calendar',
          period: 'weekly',
        })
      ).toBe(seconds('2026-12-09T00:00:00.000Z'));
    });

    it('keeps a sliding month hash for the window duration plus a day past the month end', () => {
      expect(
        dayCountersExpireAt(new Date('2026-11-05T13:00:00.000Z'), {
          kind: 'sliding',
          durationMs: THIRTY_DAYS_MS,
        })
      ).toBe(seconds('2027-01-01T00:00:00.000Z'));
    });
  });

  describe('hourCountersExpireAt', () => {
    it('keeps a sliding hour hash for the window duration plus an hour past the day end', () => {
      expect(
        hourCountersExpireAt(
          new Date('2026-11-05T13:00:00.000Z'),
          FIVE_HOURS_MS
        )
      ).toBe(seconds('2026-11-06T06:00:00.000Z'));
    });
  });

  describe('sessionExpireAt', () => {
    it('keeps a session hash for the session duration plus an hour, rounded up to the next second', () => {
      expect(
        sessionExpireAt(new Date('2026-11-05T13:00:00.500Z'), FIVE_HOURS_MS)
      ).toBe(seconds('2026-11-05T19:00:01.000Z'));
    });
  });
});
