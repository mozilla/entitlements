/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'reflect-metadata';

import { plainToClass } from 'class-transformer';
import { validateSync } from 'class-validator';

import { PrometheusConfig } from './prometheus.config';

const validate = (raw: Record<string, unknown>) => {
  const config = plainToClass(PrometheusConfig, raw, {
    exposeDefaultValues: true,
  });
  return { config, errors: validateSync(config) };
};

describe('PrometheusConfig', () => {
  it('defaults the port to 9464', () => {
    expect(validate({}).config.port).toBe(9464);
  });

  it('parses a configured port', () => {
    expect(validate({ port: '9500' }).config.port).toBe(9500);
  });

  it('accepts a configured port', () => {
    expect(validate({ port: '9500' }).errors).toEqual([]);
  });

  it.each(['0', '65536', 'abc'])('rejects port %s', (port) => {
    expect(validate({ port }).errors).toHaveLength(1);
  });
});
