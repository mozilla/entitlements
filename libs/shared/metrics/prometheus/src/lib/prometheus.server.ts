/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Inject,
  Injectable,
  Logger,
  type LoggerService,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Registry } from 'prom-client';

import { PrometheusConfig } from './prometheus.config';
import { PrometheusRegistry } from './prometheus.registry';

/**
 * Serves `GET /metrics` on its own port, outside the Nest HTTP app, so the
 * endpoint never sits behind the app's ingress, guards or middleware.
 */
@Injectable()
export class PrometheusServer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly server: Server;

  constructor(
    private readonly config: PrometheusConfig,
    @Inject(PrometheusRegistry) private readonly registry: Registry,
    @Inject(Logger) private readonly logger: LoggerService
  ) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.server.listen(this.config.port);
    await once(this.server, 'listening');
    this.logger.log(
      `Serving metrics on port ${this.port}`,
      PrometheusServer.name
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.server.listening) return;
    const closed = once(this.server, 'close');
    this.server.close();
    this.server.closeAllConnections();
    await closed;
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await this.registry.metrics();
      res.writeHead(200, { 'Content-Type': this.registry.contentType });
      res.end(body);
    } catch (err) {
      this.logger.error(err, PrometheusServer.name);
      res.writeHead(500).end();
    }
  }
}
