/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { TypedDocumentNode } from '@apollo/client';
import { Kind, OperationTypeNode } from 'graphql';

import { cacheKeyForQuery } from './util';

type Variables = { a: string; b: string };

const EMPTY_QUERY_HASH =
  'bd9062151f2cd40bd64118221a4fb24355b3538e0d3de6e06da61de4d710d611';
const VARIABLES_HASH =
  '21f76dfbfe6dfe21f762080ef484112cf2952974cef30741fd1931e1c6d92112';

const buildQuery = (
  definitions: TypedDocumentNode<unknown, Variables>['definitions'] = []
): TypedDocumentNode<unknown, Variables> => ({
  kind: Kind.DOCUMENT,
  definitions,
});

describe('cacheKeyForQuery', () => {
  it('builds the key from the sha256 of the query and of the variables', () => {
    expect(cacheKeyForQuery(buildQuery(), { a: '1', b: '2' })).toBe(
      `cmsQueryCache:${EMPTY_QUERY_HASH}:${VARIABLES_HASH}`
    );
  });

  it('returns the same key for repeated calls with the same query', () => {
    const query = buildQuery();

    const first = cacheKeyForQuery(query, { a: '1', b: '2' });
    const second = cacheKeyForQuery(query, { a: '1', b: '2' });

    expect(second).toBe(first);
  });

  it('returns the same key regardless of variable order', () => {
    expect(cacheKeyForQuery(buildQuery(), { b: '2', a: '1' })).toBe(
      `cmsQueryCache:${EMPTY_QUERY_HASH}:${VARIABLES_HASH}`
    );
  });

  it('returns a different key for a different query with the same variables', () => {
    const otherQuery = buildQuery([
      {
        kind: Kind.OPERATION_DEFINITION,
        operation: OperationTypeNode.QUERY,
        selectionSet: { kind: Kind.SELECTION_SET, selections: [] },
      },
    ]);

    expect(cacheKeyForQuery(otherQuery, { a: '1', b: '2' })).not.toBe(
      `cmsQueryCache:${EMPTY_QUERY_HASH}:${VARIABLES_HASH}`
    );
  });
});
