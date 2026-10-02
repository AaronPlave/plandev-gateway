import jwt from 'jsonwebtoken';
import { describe, expect, test } from 'vitest';

/**
 * Who may call POST /sources/query, against a running gateway and Hasura with an ingested revision:
 *
 *   SOURCES_IT_GATEWAY=http://localhost:9000 SOURCES_IT_JWT_KEY=<HASURA_GRAPHQL_JWT_SECRET key> \
 *   SOURCES_IT_REVISION=2 SOURCES_IT_PLAN_SOURCE=1 npm test
 *
 * Skipped otherwise. Imported sources are readable by every role, like plans and datasets; these tests pin
 * that down, and that anything short of a valid session is refused.
 */
const { SOURCES_IT_GATEWAY, SOURCES_IT_JWT_KEY, SOURCES_IT_PLAN_SOURCE, SOURCES_IT_REVISION } = process.env;

function token(role: string, allowedRoles = [role], key = SOURCES_IT_JWT_KEY!) {
  return jwt.sign(
    {
      'https://hasura.io/jwt/claims': {
        'x-hasura-allowed-roles': allowedRoles,
        'x-hasura-default-role': role,
        'x-hasura-user-id': 'sources-it',
      },
      username: 'sources-it',
    },
    key,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
}

async function query(body: object, headers: Record<string, string> = {}) {
  const response = await fetch(`${SOURCES_IT_GATEWAY}/sources/query`, {
    body: JSON.stringify({ end: 2 ** 52, resources: ['*'], start: 0, ...body }),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  });
  return { body: await response.json(), status: response.status };
}

describe.skipIf(!SOURCES_IT_GATEWAY || !SOURCES_IT_JWT_KEY || !SOURCES_IT_REVISION)(
  'POST /sources/query authorization',
  () => {
    const revisionId = Number(SOURCES_IT_REVISION);

    test('without a session, or with a forged one, is refused', async () => {
      expect((await query({ revisionId })).status).toBe(401);
      const forged = token('aerie_admin', ['aerie_admin'], 'not-the-key-not-the-key-not-the-key');
      expect((await query({ revisionId }, { authorization: `Bearer ${forged}` })).status).toBe(401);
    });

    test('a role the session does not hold is refused', async () => {
      const response = await query(
        { revisionId },
        { authorization: `Bearer ${token('viewer')}`, 'x-hasura-role': 'aerie_admin' },
      );
      expect(response.status).toBe(403);
    });

    test('every role may read any revision, by revision or plan source', async () => {
      for (const role of ['viewer', 'user', 'aerie_admin']) {
        const headers = { authorization: `Bearer ${token(role)}` };
        const byRevision = await query({ revisionId }, headers);
        expect(byRevision.status).toBe(200);
        expect(byRevision.body.revisionId).toBe(revisionId);
        if (SOURCES_IT_PLAN_SOURCE) {
          const byPlanSource = await query({ planSourceId: Number(SOURCES_IT_PLAN_SOURCE) }, headers);
          expect(byPlanSource.status).toBe(200);
        }
      }
    });

    test('a revision that does not exist is not found', async () => {
      const response = await query({ revisionId: 2 ** 31 - 1 }, { authorization: `Bearer ${token('viewer')}` });
      expect(response.status).toBe(404);
    });
  },
);
