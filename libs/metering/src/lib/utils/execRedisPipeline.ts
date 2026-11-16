/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MeteringRedisPipeline } from '../metering.types';
import { toError } from './toError';

export async function execRedisPipeline(
  pipeline: MeteringRedisPipeline,
  toFailure: (cause: Error) => Error
): Promise<unknown[]> {
  let replies: Array<[Error | null, unknown]>;
  try {
    replies = await pipeline.exec();
  } catch (err) {
    throw toFailure(toError(err));
  }

  const failure = replies.find(([err]) => err !== null)?.[0];
  if (failure) {
    throw toFailure(failure);
  }
  return replies.map(([, reply]) => reply);
}
