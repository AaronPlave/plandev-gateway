import type { Request } from 'express';
import { describe, expect, test, vi } from 'vitest';
import { resolveRevision } from '../src/packages/sources/sources';

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('node-fetch', () => ({ default: fetch }));

fetch.mockImplementation(async () => ({
  json: async () => ({ data: { source_revision_by_pk: { id: 7, status: 'success', storage_kind: 'pg_chunks_v1' } } }),
}));

const req = (authorization: string, role: string) =>
  ({ get: (h: string) => ({ authorization, 'x-hasura-role': role })[h] }) as unknown as Request;

describe('resolveRevision caching', () => {
  test('reuses a resolution only for the same token, role and target', async () => {
    await resolveRevision(req('Bearer a', 'viewer'), null, 7);
    await resolveRevision(req('Bearer a', 'viewer'), null, 7);
    expect(fetch).toHaveBeenCalledTimes(1);

    await resolveRevision(req('Bearer b', 'viewer'), null, 7);
    await resolveRevision(req('Bearer a', 'user'), null, 7);
    await resolveRevision(req('Bearer a', 'viewer'), null, 8);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual([
      'Bearer a',
      'Bearer b',
      'Bearer a',
      'Bearer a',
    ]);
  });
});
