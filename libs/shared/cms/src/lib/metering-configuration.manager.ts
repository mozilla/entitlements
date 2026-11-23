/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getOperationName } from '@apollo/client/utilities';
import { Inject, Injectable } from '@nestjs/common';
import { StatsD } from 'hot-shots';
import { Histogram, type Registry } from 'prom-client';

import { PrometheusRegistry } from '@entitlements/shared/metrics/prometheus';
import { StatsDService } from '@entitlements/shared/metrics/statsd';
import { MeterBySlugResultUtil, meterBySlugQuery } from './queries/meter';
import type { StrapiMeter } from './queries/meter';
import { StrapiClient, StrapiClientEventResponse } from './strapi.client';
import type { DeepNonNullable } from './types';
import type { MeterBySlugQuery } from '../__generated__/graphql';

@Injectable()
export class MeteringConfigurationManager {
  private readonly requestDuration: Histogram<
    'method' | 'error' | 'cache' | 'cache_type' | 'operation_name'
  >;

  constructor(
    private strapiClient: StrapiClient,
    @Inject(StatsDService)
    private statsd: StatsD,
    @Inject(PrometheusRegistry) registry: Registry
  ) {
    this.requestDuration = new Histogram({
      name: 'cms_metering_request_duration_seconds',
      help: 'Duration of a Strapi request for meter configuration',
      labelNames: ['method', 'error', 'cache', 'cache_type', 'operation_name'],
      registers: [registry],
    });
    this.strapiClient.on('response', this.onStrapiClientResponse.bind(this));
  }

  onStrapiClientResponse(response: StrapiClientEventResponse) {
    const defaultTags = {
      method: response.method,
      error: response.error ? 'true' : 'false',
      cache: `${response.cache}`,
      cacheType: `${response.cacheType}`,
    };
    const operationName = response.query && getOperationName(response.query);
    const tags = operationName
      ? { ...defaultTags, operationName }
      : defaultTags;
    this.statsd.timing(
      'cms_metering_request',
      response.elapsed,
      undefined,
      tags
    );
    this.requestDuration.observe(
      {
        method: response.method,
        error: defaultTags.error,
        cache: defaultTags.cache,
        cache_type: defaultTags.cacheType,
        ...(operationName && { operation_name: operationName }),
      },
      response.elapsed / 1000
    );
  }

  async getMeterResultUtil(slug: string): Promise<MeterBySlugResultUtil> {
    const queryResult = (await this.strapiClient.query(meterBySlugQuery, {
      slug,
    })) as DeepNonNullable<MeterBySlugQuery>;

    return new MeterBySlugResultUtil(queryResult, slug);
  }

  async getMeterBySlug(slug: string): Promise<StrapiMeter | null> {
    const util = await this.getMeterResultUtil(slug);
    return util.meters.at(0) ?? null;
  }
}
