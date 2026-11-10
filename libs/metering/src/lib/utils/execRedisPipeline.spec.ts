/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { recordingRedisPipeline, rejectingRedisPipeline } from '../../testing';
import { UsageCountersError } from '../metering.error';
import { execRedisPipeline } from './execRedisPipeline';

const toFailure = (cause: Error) => new UsageCountersError('test', cause);

describe('execRedisPipeline', () => {
  it('returns the replies in command order', async () => {
    const pipeline = recordingRedisPipeline(
      [
        [null, 'OK'],
        [null, 3],
      ],
      []
    );

    await expect(execRedisPipeline(pipeline, toFailure)).resolves.toEqual([
      'OK',
      3,
    ]);
  });

  it('maps a rejected pipeline through the failure factory', async () => {
    await expect(
      execRedisPipeline(
        rejectingRedisPipeline(new Error('connection closed')),
        toFailure
      )
    ).rejects.toThrow(UsageCountersError);
  });

  it('maps the first per-command error through the failure factory', async () => {
    const pipeline = recordingRedisPipeline(
      [
        [null, 'OK'],
        [new Error('OOM'), null],
      ],
      []
    );

    await expect(execRedisPipeline(pipeline, toFailure)).rejects.toThrow(
      UsageCountersError
    );
  });
});
