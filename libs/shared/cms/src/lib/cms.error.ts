/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BaseError } from '@entitlements/shared/error';

/**
 * CMSError is not intended for direct use, except for type-checking errors.
 * When throwing a new CMSError, create a unique extension of the class.
 */
export class CMSError extends BaseError {
  constructor(message: string, info: Record<string, any>, cause?: Error) {
    super(message, { info, cause });
    this.name = 'CMSError';
  }
}

export class StrapiQueryError extends CMSError {
  constructor(query: any, variables: Record<string, any>, cause: Error) {
    super('Strapi query failed', { query, variables }, cause);
    this.name = 'StrapiQueryError';
  }
}

export class QueriesUtilError extends CMSError {
  constructor(message: string, info: Record<string, any>, cause?: Error) {
    super(message, info, cause);
    this.name = 'QueriesUtilError';
  }
}

export class MeterNotFoundError extends QueriesUtilError {
  constructor(slug: string) {
    super('Meter not found', { slug });
    this.name = 'MeterNotFoundError';
  }
}

export class MeterInvalidNotificationThresholdError extends QueriesUtilError {
  constructor(slug: string, value: number) {
    super('Notification threshold must be between 0 and 100', { slug, value });
    this.name = 'MeterInvalidNotificationThresholdError';
  }
}

export class MeterInvalidWindowError extends QueriesUtilError {
  constructor(slug: string, reason: string) {
    super('Meter window configuration is invalid', { slug, reason });
    this.name = 'MeterInvalidWindowError';
  }
}
