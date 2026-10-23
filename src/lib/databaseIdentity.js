// This module only reads the independently provisioned database identity.
// Provisioning belongs to an explicit operator command, never app startup/reset.
import { ConfigurationError, validatePostgresUrl, validateOperatorPassword } from './runtimeConfig.js';

export const DEPLOYMENT_IDENTITY_ID = 1;
export const DEMO_ORIGIN = 'https://artdesign-for-demo.zeabur.app';
export const DEMO_RESET_CONFIRMATION = 'RESET DEMO DATABASE';
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DatabaseIdentityError extends Error {
  constructor(code, message) { super(message); this.name = 'DatabaseIdentityError'; this.code = code; }
}

export function validateDemoResetConfig(env = process.env) {
  if (env.DEMO_SEED !== 'yes' || env.DEMO_RESET_CONFIRM !== DEMO_RESET_CONFIRMATION) {
    throw new ConfigurationError('DEMO_RESET_CONFIRM', `destructive reset requires DEMO_SEED=yes and DEMO_RESET_CONFIRM=${DEMO_RESET_CONFIRMATION}`);
  }
  if (env.APP_BASE_URL !== DEMO_ORIGIN) {
    throw new ConfigurationError('APP_BASE_URL', 'Demo reset is allowed only for the exact configured Demo origin');
  }
  validatePostgresUrl(env.DATABASE_URL);
  if (typeof env.DEMO_INSTANCE_ID !== 'string' || !INSTANCE_ID.test(env.DEMO_INSTANCE_ID)) {
    throw new ConfigurationError('DEMO_INSTANCE_ID', 'set the independently provisioned Demo database instance UUID; never infer or create it during reset');
  }
  return { instanceId: env.DEMO_INSTANCE_ID, password: validateOperatorPassword(env.DEMO_PASSWORD, 'DEMO_PASSWORD') };
}

export async function requireDeploymentIdentity(client, { environment, instanceId }) {
  if (!['production', 'demo', 'restore'].includes(environment) || !INSTANCE_ID.test(String(instanceId || ''))) {
    throw new DatabaseIdentityError('invalid_deployment_identity', 'Provide a valid expected deployment environment and instance UUID');
  }
  let identity;
  try { identity = await client.deploymentIdentity.findUnique({ where: { id: DEPLOYMENT_IDENTITY_ID } }); }
  catch {
    throw new DatabaseIdentityError('deployment_identity_unavailable', 'Database identity is unavailable; apply the reviewed metadata migration and provision this target independently before maintenance');
  }
  if (!identity || identity.environment !== environment || identity.instanceId !== instanceId) {
    throw new DatabaseIdentityError('deployment_identity_mismatch', 'Database identity does not match the requested deployment; stop and verify the database target');
  }
  return identity;
}

export async function assertDemoDatabase(client, env = process.env) {
  const { instanceId } = validateDemoResetConfig(env);
  return requireDeploymentIdentity(client, { environment: 'demo', instanceId });
}
