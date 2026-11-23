/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LoggerService } from '@nestjs/common';
import { Counter, Registry } from 'prom-client';

import { PrometheusConfig } from './prometheus.config';
import { PrometheusServer } from './prometheus.server';

describe('PrometheusServer', () => {
  let registry: Registry;
  let logger: jest.Mocked<Pick<LoggerService, 'log' | 'error'>>;
  let server: PrometheusServer;

  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

  beforeEach(async () => {
    registry = new Registry();
    new Counter({
      name: 'test_events_total',
      help: 'Test events',
      registers: [registry],
    }).inc(3);
    logger = { log: jest.fn(), error: jest.fn() };
    server = new PrometheusServer(
      { port: 0 } as PrometheusConfig,
      registry,
      logger as unknown as LoggerService
    );
    await server.onApplicationBootstrap();
  });

  afterEach(async () => {
    await server.onApplicationShutdown();
  });

  it('logs the port it serves metrics on', () => {
    expect(logger.log).toHaveBeenCalledWith(
      `Serving metrics on port ${server.port}`,
      'PrometheusServer'
    );
  });

  describe('GET /metrics', () => {
    it('responds 200', async () => {
      expect((await fetch(url('/metrics'))).status).toBe(200);
    });

    it('responds with the Prometheus content type', async () => {
      const res = await fetch(url('/metrics'));

      expect(res.headers.get('content-type')).toBe(registry.contentType);
    });

    it('responds with the registry metrics', async () => {
      const res = await fetch(url('/metrics'));

      expect(await res.text()).toContain('test_events_total 3');
    });

    it('ignores a query string', async () => {
      expect((await fetch(url('/metrics?x=1'))).status).toBe(200);
    });
  });

  it.each(['/', '/__heartbeat__', '/metrics/extra'])(
    'responds 404 for GET %s',
    async (path) => {
      expect((await fetch(url(path))).status).toBe(404);
    }
  );

  it('responds 404 for POST /metrics', async () => {
    expect((await fetch(url('/metrics'), { method: 'POST' })).status).toBe(404);
  });

  describe('when collecting metrics fails', () => {
    const failure = new Error('collect failed');

    beforeEach(() => {
      jest.spyOn(registry, 'metrics').mockRejectedValue(failure);
    });

    it('responds 500', async () => {
      expect((await fetch(url('/metrics'))).status).toBe(500);
    });

    it('logs the error', async () => {
      await fetch(url('/metrics'));

      expect(logger.error).toHaveBeenCalledWith(failure, 'PrometheusServer');
    });
  });

  it('stops accepting connections on shutdown', async () => {
    const target = url('/metrics');

    await server.onApplicationShutdown();

    await expect(fetch(target)).rejects.toThrow();
  });

  it('shuts down when it never started', async () => {
    const idle = new PrometheusServer(
      { port: 0 } as PrometheusConfig,
      registry,
      logger as unknown as LoggerService
    );

    await expect(idle.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('fails to start when the port is taken', async () => {
    const clash = new PrometheusServer(
      { port: server.port } as PrometheusConfig,
      registry,
      logger as unknown as LoggerService
    );

    await expect(clash.onApplicationBootstrap()).rejects.toThrow('EADDRINUSE');
  });
});
