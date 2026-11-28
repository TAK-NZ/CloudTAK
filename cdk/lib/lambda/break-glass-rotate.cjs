'use strict';
/**
 * Break-glass password rotation, run on demand (`aws lambda invoke`, see docs/BREAK_GLASS.md).
 *
 * Sets a new random password on the break-glass account and in the sealed secret, in an order that never
 * leaves the secret's current version wrong:
 *
 *   1. Generate the new password and store it in the secret as a PENDING version. The current version is
 *      untouched, so a failure from here on still leaves a usable credential.
 *   2. Set the password in Authentik with the rotation token, which can reset the password of the break-glass
 *      account only.
 *   3. Make the new version current (the old one keeps the AWSPREVIOUS label).
 *
 * If step 2 fails nothing has changed. If step 3 fails the new password is in the pending version, and the
 * error says how to promote it. The function returns the new version id and never the password.
 *
 * Written as a factory so that it can be tested with fake dependencies (see test/unit/lambda).
 */
function createHandler({ secrets, fetchFn, randomPassword, log = () => {} }) {
  async function handler() {
    const adminSecretName = process.env.ADMIN_SECRET_NAME;
    const rotationSecretName = process.env.ROTATION_SECRET_NAME;
    const authentikUrl = (process.env.AUTHENTIK_URL || '').replace(/\/+$/, '');
    if (!adminSecretName || !rotationSecretName || !authentikUrl) {
      throw new Error('ADMIN_SECRET_NAME, ROTATION_SECRET_NAME and AUTHENTIK_URL must be set');
    }
    const rotation = JSON.parse(await secrets.getCurrent(rotationSecretName));
    if (!rotation.token || !rotation.userPk) {
      throw new Error('The rotation secret is empty. Deploy the stack again so that the provisioning function fills it.');
    }
    const current = JSON.parse(await secrets.getCurrent(adminSecretName));
    if (!current.username) throw new Error('The break-glass secret has no username');
    const password = randomPassword();
    // 1. Pending version first
    const versionId = await secrets.putPending(adminSecretName, JSON.stringify({ ...current, password }));
    log('info', 'Pending secret version stored', { versionId });
    // 2. Authentik
    const response = await fetchFn(`${authentikUrl}/api/v3/core/users/${rotation.userPk}/set_password/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rotation.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Authentik refused the new password (${response.status}). The secret is unchanged and still current. ${String(text).slice(0, 200)}`);
    }
    log('info', 'Password set in Authentik');
    // 3. Promote
    try {
      await secrets.promote(adminSecretName, versionId);
    } catch (error) {
      throw new Error(
        `The password was changed in Authentik but the new secret version ${versionId} could not be made current (${error.message}). ` +
        `Promote it: aws secretsmanager update-secret-version-stage --secret-id ${adminSecretName} --version-stage AWSCURRENT --move-to-version-id ${versionId}`
      );
    }
    log('info', 'Secret version promoted', { versionId });
    return { status: 'rotated', secretVersion: versionId };
  }
  return { handler };
}
let deployed;
function getDeployed() {
  if (!deployed) {
    const crypto = require('crypto');
    const {
      SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand, UpdateSecretVersionStageCommand, DescribeSecretCommand
    } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    deployed = createHandler({
      secrets: {
        getCurrent: async (id) => (await client.send(new GetSecretValueCommand({ SecretId: id }))).SecretString,
        putPending: async (id, value) => {
          const token = crypto.randomUUID();
          await client.send(new PutSecretValueCommand({
            SecretId: id, SecretString: value, ClientRequestToken: token, VersionStages: ['AWSPENDING']
          }));
          return token;
        },
        promote: async (id, versionId) => {
          const meta = await client.send(new DescribeSecretCommand({ SecretId: id }));
          const from = Object.entries(meta.VersionIdsToStages || {}).find(([, stages]) => stages.includes('AWSCURRENT'));
          await client.send(new UpdateSecretVersionStageCommand({
            SecretId: id,
            VersionStage: 'AWSCURRENT',
            MoveToVersionId: versionId,
            RemoveFromVersionId: from ? from[0] : undefined
          }));
          // The version is current now. Drop its pending label, so that it does not look unfinished.
          await client.send(new UpdateSecretVersionStageCommand({
            SecretId: id,
            VersionStage: 'AWSPENDING',
            RemoveFromVersionId: versionId
          })).catch(() => {});
        }
      },
      fetchFn: fetch,
      // 32 characters from an unambiguous alphanumeric set, drawn without modulo bias
      randomPassword: () => {
        let out = '';
        while (out.length < 32) {
          const byte = crypto.randomBytes(1)[0];
          if (byte < 256 - (256 % alphabet.length)) out += alphabet[byte % alphabet.length];
        }
        return out;
      },
      log: (level, message, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: level.toUpperCase(), message, ...data }))
    });
  }
  return deployed;
}
exports.createHandler = createHandler;
exports.handler = () => getDeployed().handler();
