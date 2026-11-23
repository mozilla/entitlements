/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { type MetricValueWithName, Registry } from 'prom-client';

import {
  PrometheusRouteMiddleware,
  normalizeRoute,
} from './prometheus-route.middleware';

type FakeResponse = Response & { finish: () => void };

const buildRequest = (overrides: Partial<Request> = {}): Request =>
  ({ method: 'GET', path: '/some/path', ...overrides }) as unknown as Request;

const buildResponse = (statusCode = 200): FakeResponse => {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    statusCode,
    finish: () => emitter.emit('finish'),
  }) as unknown as FakeResponse;
};

describe('PrometheusRouteMiddleware', () => {
  let registry: Registry;
  let middleware: PrometheusRouteMiddleware;
  let next: jest.MockedFunction<NextFunction>;

  const requestCount = async () =>
    (await registry.getSingleMetric('http_server_requests_total')?.get())
      ?.values;
  const durationCount = async () =>
    (
      await registry
        .getSingleMetric('http_server_request_duration_seconds')
        ?.get()
    )?.values.filter((value: MetricValueWithName<string>) =>
      value.metricName?.endsWith('_count')
    );

  beforeEach(() => {
    registry = new Registry();
    middleware = new PrometheusRouteMiddleware(registry);
    next = jest.fn();
  });

  it('calls next', () => {
    middleware.use(buildRequest(), buildResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('records nothing until the response finishes', async () => {
    middleware.use(buildRequest(), buildResponse(), next);

    expect(await requestCount()).toEqual([]);
  });

  describe('when the response finishes', () => {
    beforeEach(() => {
      const res = buildResponse(201);
      middleware.use(
        buildRequest({
          method: 'POST',
          route: { path: '/v1/usage' },
        } as Partial<Request>),
        res,
        next
      );
      res.finish();
    });

    it('counts the request by method, route and status code', async () => {
      expect(await requestCount()).toEqual([
        {
          value: 1,
          labels: { method: 'POST', route: 'v1/usage', status_code: '201' },
        },
      ]);
    });

    it('times the request with the same labels', async () => {
      expect(await durationCount()).toEqual([
        expect.objectContaining({
          value: 1,
          labels: { method: 'POST', route: 'v1/usage', status_code: '201' },
        }),
      ]);
    });
  });

  it('labels a request with no matched route as unmatched', async () => {
    const res = buildResponse(404);
    middleware.use(buildRequest(), res, next);
    res.finish();

    expect(await requestCount()).toEqual([
      {
        value: 1,
        labels: { method: 'GET', route: 'unmatched', status_code: '404' },
      },
    ]);
  });
});

describe('normalizeRoute', () => {
  it.each([
    { path: '/v1/usage/:slug', expected: 'v1/usage/:slug' },
    { path: '/', expected: 'root' },
    { path: undefined, expected: 'unmatched' },
    { path: '', expected: 'unmatched' },
  ])('maps $path to $expected', ({ path, expected }) => {
    expect(normalizeRoute(path)).toBe(expected);
  });
});
