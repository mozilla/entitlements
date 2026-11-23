/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram, type Registry } from 'prom-client';

import { PrometheusRegistry } from './prometheus.registry';

const LABELS = ['method', 'route', 'status_code'] as const;

/**
 * Counts and times every HTTP response, labelled by method, Express route
 * pattern (or `unmatched`) and status code. Runs before Nest's guards, so
 * auth failures and validation errors are included.
 */
@Injectable()
export class PrometheusRouteMiddleware implements NestMiddleware {
  private readonly requests: Counter<(typeof LABELS)[number]>;
  private readonly duration: Histogram<(typeof LABELS)[number]>;

  constructor(@Inject(PrometheusRegistry) registry: Registry) {
    this.requests = new Counter({
      name: 'http_server_requests_total',
      help: 'HTTP responses sent',
      labelNames: LABELS,
      registers: [registry],
    });
    this.duration = new Histogram({
      name: 'http_server_request_duration_seconds',
      help: 'Time from request entry until the response finished',
      labelNames: LABELS,
      registers: [registry],
    });
  }

  use(req: Request, res: Response, next: NextFunction) {
    const stopTimer = this.duration.startTimer();

    res.on('finish', () => {
      const labels = {
        method: req.method,
        route: normalizeRoute(req.route?.path),
        status_code: String(res.statusCode),
      };
      this.requests.inc(labels);
      stopTimer(labels);
    });

    next();
  }
}

/**
 * Strips the leading `/` from an Express route pattern so downstream
 * statsd receivers (Graphite/Prometheus/etc.) that sanitize `/` don't
 * produce tag values like `-v1-billing-and-subscriptions`. Falls back
 * to `unmatched` when no route was resolved (e.g., 404).
 */
export const normalizeRoute = (path: string | undefined): string => {
  if (!path) return 'unmatched';
  return path.replace(/^\//, '') || 'root';
};
