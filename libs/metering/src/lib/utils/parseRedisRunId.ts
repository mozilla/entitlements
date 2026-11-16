/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const RUN_ID_PATTERN = /^run_id:(\S+)$/m;

export function parseRedisRunId(serverInfo: string): string | null {
  return serverInfo.match(RUN_ID_PATTERN)?.[1] ?? null;
}
