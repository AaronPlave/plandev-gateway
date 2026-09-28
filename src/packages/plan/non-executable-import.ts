import fetch from 'node-fetch';
import type { HasuraError } from '../../types/hasura.js';
import type { ModelDeclaration, SerializedValue, SimulationResultsTransfer } from '../../types/plan-transfer.js';
import { generateJwt } from '../auth/functions.js';
import { removeUploadedFile, storeUploadedFile } from '../files/store.js';
import { getEnv } from '../../env.js';
import getLogger from '../../logger.js';
import { intervalToMicroseconds, isoToDoyTimestamp } from '../../util/time.js';
import gql from './gql.js';

/**
 * Backend calls for importing a self-contained PlanTransfer as a non-executable, read-only plan.
 *
 * The gateway creates the non-executable model's row through Hasura, whose event triggers then have merlin register
 * its types. Merlin owns the imported simulation dataset and the plan's read-only flag; the gateway stages files, says
 * who the caller is, and asks for the plan to be made read-only once it has finished writing to it. How each payload
 * reaches the backend is kept inside these helpers so it can change without touching `/importPlan`.
 */

const logger = getLogger('packages/plan/non-executable-import');

const { HASURA_API_URL, PLANDEV_MERLIN_URL } = getEnv();

const GQL_API_URL = `${HASURA_API_URL}/v1/graphql`;

export async function postGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(GQL_API_URL, {
    body: JSON.stringify({ query, variables }),
    headers,
    method: 'POST',
  });
  const json = (await response.json()) as { data?: T } & Partial<HasuraError>;

  if (json.errors?.length) {
    throw new Error(json.errors.map(({ message }) => message).join('; '));
  }
  if (json.data == null) {
    throw new Error(`GraphQL request failed with status ${response.status}.`);
  }

  return json.data;
}

/**
 * Calls one of merlin's endpoints directly rather than through Hasura, so it is not exposed to other clients, and
 * returns the response body as text. Merlin's errors are `FormattedError`s, whose `message` is thrown.
 */
async function postMerlin(endpoint: string, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${PLANDEV_MERLIN_URL}/${endpoint}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const text = await response.text();

  if (!response.ok) {
    let message: string | undefined;
    try {
      message = (JSON.parse(text) as { message?: string }).message;
    } catch {
      // not a FormattedError
    }
    throw new Error(message ?? `merlin ${endpoint} failed with status ${response.status}.`);
  }

  return text;
}

/** A non-executable model an import created, with what is needed to delete it again. */
export type CreatedNonExecutableModel = {
  definitionFile: { id: number; name: string };
  id: number;
  owner: string;
};

/**
 * Headers for a short-lived admin token acting as `user`. Only admins may insert or delete models through Hasura; the
 * caller must already be known to be allowed to create plans.
 */
function adminHeaders(user: string): Record<string, string> {
  const adminToken = generateJwt(user, 'admin', ['admin'], '10s');
  if (adminToken === null) {
    throw new Error('Could not create a token to manage the non-executable model.');
  }

  return { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'x-hasura-role': 'admin' };
}

/**
 * Stages the model declaration as a JSON definition file and inserts a non-executable model for it, owned by the
 * caller. Its types are registered asynchronously afterwards; see `waitForModelTypes`.
 *
 * The insert uses a short-lived admin token (see `adminHeaders`). Since the admin role skips Hasura's column presets,
 * `owner` must be the user from the caller's verified token rather than the request's `x-hasura-user-id` header.
 */
export async function createNonExecutableModel(
  model: ModelDeclaration,
  { name, owner }: { name: string; owner: string },
): Promise<CreatedNonExecutableModel> {
  const headers = adminHeaders(owner);
  const definitionFile = await storeUploadedFile('plan-transfer-model.json', JSON.stringify(model));

  try {
    const { insert_mission_model_one: inserted } = await postGraphQL<{
      insert_mission_model_one: { id: number } | null;
    }>(
      gql.INSERT_NON_EXECUTABLE_MODEL,
      {
        definition_file_id: definitionFile.id,
        description: describeNonExecutableModel(model, name),
        mission: typeof model.metadata?.mission === 'string' ? model.metadata.mission : '',
        name,
        owner,
        // unique for the (mission, name, version) key, and tells the user when it was imported
        version: new Date().toISOString(),
      },
      headers,
    );
    if (inserted == null) {
      throw new Error('Non-executable model creation returned no model id.');
    }

    return { definitionFile, id: inserted.id, owner };
  } catch (error) {
    await removeUploadedFile(definitionFile);
    throw error;
  }
}

/**
 * Deletes a non-executable model a failed import created, and then its definition file. The database only removes a
 * plan's non-executable model when a read-only plan is deleted, and a failed import never got as far as marking its
 * plan read-only, so the import has to clean up the model itself. Delete the plan first: deleting the model would
 * otherwise leave the plan with no model.
 *
 * Best-effort, since it runs while handling another failure: problems are logged, never thrown.
 */
export async function deleteNonExecutableModel({
  definitionFile,
  id,
  owner,
}: CreatedNonExecutableModel): Promise<void> {
  try {
    await postGraphQL(gql.DELETE_MISSION_MODEL, { id }, adminHeaders(owner));
  } catch (error) {
    // the model still references its definition file, so the file stays too
    logger.error(`Could not delete non-executable model ${id}: ${(error as Error).message}`);
    return;
  }

  await removeUploadedFile(definitionFile);
}

function describeNonExecutableModel({ activity_types, resource_types }: ModelDeclaration, planName: string): string {
  return (
    `Non-executable model imported with the plan "${planName}". It declares ${activity_types.length} activity ` +
    `type(s) and ${resource_types.length} resource type(s) and cannot be simulated.`
  );
}

const MODEL_TYPE_REFRESH_POLL_MS = 250;
// Matches the refresh triggers' `timeout_sec`.
const MODEL_TYPE_REFRESH_TIMEOUT_MS = 300_000;

type RefreshLog = { error_message: string | null; pending: boolean; success: boolean };

type ModelTypeRefreshStatus = {
  mission_model_by_pk: {
    refresh_activity_type_logs: RefreshLog[];
    refresh_model_parameter_logs: RefreshLog[];
    refresh_resource_type_logs: RefreshLog[];
  } | null;
};

/**
 * Waits until merlin has registered a new model's activity types, resource types and parameters. Inserting the
 * model fires the `refreshActivityTypes`, `refreshResourceTypes` and `refreshModelParameters` event triggers, and
 * each writes one row to its log view: not there yet or `pending` means keep waiting, and since the triggers use
 * `num_retries: 0`, the first finished row is final.
 *
 * The log views read `hdb_catalog.event_log`. The rows read here are only seconds old, so this stays safe even if
 * Hasura's event-log cleanup is turned on later.
 *
 * Stops polling once `signal` is aborted.
 */
export async function waitForModelTypes(
  modelId: number,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + MODEL_TYPE_REFRESH_TIMEOUT_MS;

  while (!signal?.aborted) {
    const { mission_model_by_pk: model } = await postGraphQL<ModelTypeRefreshStatus>(
      gql.MODEL_TYPE_REFRESH_STATUS,
      { modelId },
      headers,
    );
    if (model == null) {
      throw new Error(`Model ${modelId} was not found while waiting for its types to be registered.`);
    }

    const latestLogs: [string, RefreshLog | undefined][] = [
      ['activity types', model.refresh_activity_type_logs[0]],
      ['resource types', model.refresh_resource_type_logs[0]],
      ['model parameters', model.refresh_model_parameter_logs[0]],
    ];

    const failed = latestLogs.find(([, log]) => log !== undefined && !log.pending && !log.success);
    if (failed) {
      const [what, log] = failed;
      throw new Error(`Registering the model's ${what} failed: ${log?.error_message ?? 'no error message given'}`);
    }

    if (latestLogs.every(([, log]) => log !== undefined && !log.pending && log.success)) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${MODEL_TYPE_REFRESH_TIMEOUT_MS / 1000} s waiting for the model's types to be registered.`,
      );
    }

    await new Promise(resolve => setTimeout(resolve, MODEL_TYPE_REFRESH_POLL_MS));
  }
}

/**
 * Has merlin store `results` (if any) as a successful simulation dataset for the plan.
 *
 * Spans and profiles are staged as a file merlin reads
 * from the shared file store, and removed once merlin is done with them. The simulation's window and arguments go in
 * the call itself, so merlin has them before reading the file: timestamps in merlin's UTC day-of-year format, the
 * duration in microseconds.
 *
 * `results` must already reference the plan's directive ids (see `remapResultDirectiveIds`).
 */
export async function insertExternalSimulationDataset({
  planDuration,
  planId,
  planStartTime,
  requester,
  results,
  simulationArguments,
}: {
  /** A Postgres interval, as on the plan. */
  planDuration: string;
  planId: number;
  /** ISO 8601, as on the plan. */
  planStartTime: string;
  /** The user from the caller's verified token. */
  requester: string;
  results: SimulationResultsTransfer | undefined;
  simulationArguments: Record<string, SerializedValue>;
}): Promise<void> {
  const resultsFile =
    results &&
    (await storeUploadedFile(
      'plan-transfer-results.json',
      JSON.stringify({
        // merlin streams each profile once, so it needs `type` and `schema` before `segments`
        profiles: Object.fromEntries(
          Object.entries(results.profiles).map(([name, { type, schema, segments }]) => [
            name,
            // eslint-disable-next-line sort-keys -- key order is what merlin's parser needs
            { type, schema, segments },
          ]),
        ),
        spans: results.spans,
      }),
    ));

  try {
    await postMerlin('insertExternalSimulationDataset', {
      planId,
      planStartTime: isoToDoyTimestamp(planStartTime),
      requester,
      resultsFileId: resultsFile?.id ?? null,
      simulationArguments,
      // results either carry their own window or inherit the plan's
      simulationDuration: results?.duration ?? intervalToMicroseconds(planDuration),
      simulationStartTime: isoToDoyTimestamp(results?.start_time ?? planStartTime),
    });
  } finally {
    if (resultsFile) {
      await removeUploadedFile(resultsFile);
    }
  }
}

/**
 * Has merlin mark the imported plan read-only, once the gateway has finished writing to it: from then on the database
 * refuses changes to its activities, simulation and bounds, the gateway's included.
 */
export async function markPlanReadOnly(planId: number): Promise<void> {
  await postMerlin('markPlanReadOnly', { planId });
}
