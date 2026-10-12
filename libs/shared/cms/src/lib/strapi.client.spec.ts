/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { faker } from '@faker-js/faker';
import { meterBySlugQuery } from './queries/meter/query';
import { StrapiClient } from './strapi.client';
import { MeterBySlugQuery } from '../__generated__/graphql';
import { StrapiQueryError } from './cms.error';
import { MockStrapiClientConfigProvider } from './strapi.client.config';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MockFirestoreProvider } from '@entitlements/shared/db/firestore';
import { CacheClear } from '@type-cacheable/core';

jest.mock('graphql-request', () => ({
  GraphQLClient: function () {
    return {
      request: jest.fn(),
    };
  },
}));

jest.mock('@type-cacheable/core', () => {
  const noopDecorator =
    () =>
    (
      target: any,
      propertyKey: string | symbol,
      descriptor: PropertyDescriptor
    ) =>
      descriptor;

  const Cacheable = jest.fn(() => noopDecorator);
  const CacheClear = jest.fn(() => noopDecorator);

  const defaultExport = {
    setOptions: jest.fn(),
  };

  return {
    __esModule: true,
    default: defaultExport,
    Cacheable,
    CacheClear,
  };
});

jest.mock('@entitlements/shared/db/type-cacheable', () => ({
  MemoryAdapter: jest.fn().mockImplementation(() => ({})),
  FirestoreAdapter: jest.fn().mockImplementation(() => ({})),
  CacheFirstStrategy: jest.fn().mockImplementation(() => ({})),
  StaleWhileRevalidateWithFallbackStrategy: jest
    .fn()
    .mockImplementation(() => ({})),
}));

jest.useFakeTimers();

describe('StrapiClient', () => {
  let strapiClient: StrapiClient;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MockStrapiClientConfigProvider,
        StrapiClient,
        MockFirestoreProvider,
        {
          provide: Logger,
          useValue: {
            error: jest.fn(),
            log: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            info: jest.fn(),
          },
        },
      ],
    }).compile();

    strapiClient = module.get(StrapiClient);
  });

  describe('query', () => {
    const mockResponse = faker.string.sample();
    const slug = faker.string.sample();
    const queryArgs = { slug };

    describe('success', () => {
      let result: MeterBySlugQuery | null;

      beforeEach(async () => {
        jest
          .spyOn(strapiClient.client, 'request')
          .mockResolvedValueOnce(mockResponse);

        result = await strapiClient.query(meterBySlugQuery, {
          slug,
        });
      });

      it('returns the response from graphql', () => {
        expect(result).toEqual(mockResponse);
      });

      it('calls cms with expected params', () => {
        expect(strapiClient.client.request).toHaveBeenCalledWith({
          document: meterBySlugQuery,
          variables: {
            slug,
          },
        });
      });
    });

    it('throws an error when the graphql request fails', async () => {
      const error = new Error(faker.word.sample());
      jest.spyOn(strapiClient.client, 'request').mockRejectedValueOnce(error);

      await expect(() =>
        strapiClient.query(meterBySlugQuery, queryArgs)
      ).rejects.toThrow(
        new StrapiQueryError(meterBySlugQuery, queryArgs, error)
      );
    });
  });

  describe('invalidateQueryCache', () => {
    it('invokes CacheClear', async () => {
      await strapiClient.invalidateQueryCache(meterBySlugQuery, {
        slug: 'test-slug',
      });
      expect(CacheClear).toHaveBeenCalledTimes(2);
    });
  });
});
