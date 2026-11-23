/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Test } from '@nestjs/testing';
import { StatsD } from 'hot-shots';

import { StatsDConfig } from './statsd.config';
import {
  DEFAULT_STATSD_MAX_BUFFER_SIZE,
  StatsDProvider,
  StatsDService,
} from './statsd.provider';

jest.mock('hot-shots');

const MOCK_HOST = '127.0.0.1';
const MOCK_PORT = 8125;

async function createStatsD(config: StatsDConfig): Promise<StatsD> {
  const moduleRef = await Test.createTestingModule({
    providers: [StatsDProvider, { provide: StatsDConfig, useValue: config }],
  }).compile();
  return moduleRef.get<StatsD>(StatsDService);
}

describe('StatsDProvider', () => {
  beforeEach(() => {
    jest.mocked(StatsD).mockClear();
  });

  it('creates a mock client when the host is empty', async () => {
    await createStatsD({ host: '' });

    expect(StatsD).toHaveBeenCalledWith({ mock: true });
  });

  it.each([undefined, 0])(
    'buffers metrics up to the default size when maxBufferSize is %s',
    async (maxBufferSize) => {
      await createStatsD({ host: MOCK_HOST, port: MOCK_PORT, maxBufferSize });

      expect(StatsD).toHaveBeenCalledWith({
        host: MOCK_HOST,
        port: MOCK_PORT,
        maxBufferSize: DEFAULT_STATSD_MAX_BUFFER_SIZE,
      });
    }
  );

  it('uses the configured maxBufferSize', async () => {
    await createStatsD({
      host: MOCK_HOST,
      port: MOCK_PORT,
      maxBufferSize: 8192,
    });

    expect(StatsD).toHaveBeenCalledWith({
      host: MOCK_HOST,
      port: MOCK_PORT,
      maxBufferSize: 8192,
    });
  });
});
