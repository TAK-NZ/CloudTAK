import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { ContextEnvironmentConfig } from '../stack-config';
import { CLOUDTAK_CONSTANTS } from '../utils/constants';

export interface BreakGlassProps {
  envConfig: ContextEnvironmentConfig;
  /** The sealed secret that holds the break-glass account's username and password. */
  adminPasswordSecret: secretsmanager.Secret;
  /** Key that encrypts the rotation secret. */
  kmsKey: kms.IKey;
  authentikUrl: string;
  takAdminEmail: string;
}

/** The Authentik group that the web login flows refuse (created by auth-infra). */
export const BREAK_GLASS_GROUP = 'tak-break-glass';
/** Log group of the Authentik LDAP outpost (created by auth-infra). */
export const LDAP_LOG_GROUP = 'LDAP';

/**
 * The CloudTAK break-glass account (`ckadmin`): a local system administrator that is the last way in when
 * sign-in through Authentik is not available. Decision record: NZISM MFA decisions, "Break-glass".
 *
 *   - The account's password is a sealed secret. Nothing injects it: it is not in the CloudTAK container
 *     environment and not in the execution role's grants.
 *   - The provisioning function (runs on every deploy) only creates the account when it is missing, puts it in
 *     `tak-break-glass`, and keeps a rotation token that can reset that one account's password. It never
 *     resets an existing password.
 *   - The rotation function sets a new random password in Authentik and in the secret, on demand.
 *   - `ckadmin` is read by the break-glass role only (assumed with MFA). The role's principals are configurable.
 *
 * With `cloudtak.breakGlass.sealed` (production) the secret additionally denies every other reader, including
 * account administrators, and the stack alarms on a read of the secret, on any LDAP bind as the account, and
 * on a change to the secret's policy. Without it (Demo, Test) the secret behaves as before and nothing alarms.
 */
export class BreakGlass extends Construct {
  public readonly role: iam.Role;
  public readonly rotateFunction: lambda.Function;
  public readonly rotationSecret: secretsmanager.Secret;
  public readonly alertTopic?: sns.Topic;

  constructor(scope: Construct, id: string, props: BreakGlassProps) {
    super(scope, id);
    const { envConfig, adminPasswordSecret, kmsKey, authentikUrl, takAdminEmail } = props;
    const stackName = envConfig.stackName;
    const stack = cdk.Stack.of(this);
    const settings = envConfig.cloudtak.breakGlass ?? {};
    const sealed = settings.sealed ?? false;
    const prefix = `TAK-${stackName}-CloudTAK`;

    // Rotation secret: the rotation token and the pk of the account it may reset. Only the two functions read it.
    this.rotationSecret = new secretsmanager.Secret(this, 'RotationSecret', {
      description: `${prefix} break-glass rotation token (resets the password of one account only)`,
      secretName: `${prefix}/API/Admin-Rotation`,
      secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
      encryptionKey: kmsKey,
      removalPolicy: envConfig.general.removalPolicy === 'RETAIN' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    // ---- Roles. Fixed names, because the read alarm and the secret policy refer to them. ----
    const provisionRole = new iam.Role(this, 'ProvisionRole', {
      roleName: `${prefix}-BreakGlassProvision`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')]
    });
    const rotateRole = new iam.Role(this, 'RotateRole', {
      roleName: `${prefix}-BreakGlassRotate`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')]
    });

    // The two secrets are encrypted with the stack's key, which is imported by ARN. CDK cannot tell that an imported key
    // is in this account, so Secret.grantRead/grantWrite add no KMS permission for it. The key policy delegates to IAM,
    // so the roles need these statements themselves (the same shape cloudtak-api.ts uses), limited to Secrets Manager.
    const secretsKmsAccess = () => new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [kmsKey.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${stack.region}.amazonaws.com` } }
    });
    provisionRole.addToPolicy(secretsKmsAccess());
    rotateRole.addToPolicy(secretsKmsAccess());

    // The Authentik admin token belongs to auth-infra, which encrypts it with its own key
    const adminTokenArn = `arn:${stack.partition}:secretsmanager:${stack.region}:${stack.account}:secret:TAK-${stackName}-AuthInfra/Authentik/Admin-API-Token-*`;
    provisionRole.addToPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [adminTokenArn] }));
    provisionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${stack.region}.amazonaws.com` } }
    }));
    adminPasswordSecret.grantRead(provisionRole); // only to create the account when it is missing
    this.rotationSecret.grantRead(provisionRole);
    this.rotationSecret.grantWrite(provisionRole);

    this.rotationSecret.grantRead(rotateRole);
    adminPasswordSecret.grantRead(rotateRole);
    adminPasswordSecret.grantWrite(rotateRole);
    rotateRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:DescribeSecret', 'secretsmanager:UpdateSecretVersionStage'],
      resources: [adminPasswordSecret.secretArn]
    }));

    // ---- Provisioning (every deploy) ----
    const provisionFunction = new lambda.Function(this, 'ProvisionFunction', {
      functionName: `${prefix}-BreakGlassProvision`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 128,
      role: provisionRole,
      logGroup: new logs.LogGroup(this, 'ProvisionLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY
      }),
      code: lambda.Code.fromInline(fs.readFileSync(path.join(__dirname, '../lambda/break-glass-provision.cjs'), 'utf8'))
    });
    const provider = new cr.Provider(this, 'ProvisionProvider', { onEventHandler: provisionFunction });
    new cdk.CustomResource(this, 'Provision', {
      serviceToken: provider.serviceToken,
      properties: {
        AuthStackName: `TAK-${stackName}-AuthInfra`,
        AdminSecretName: adminPasswordSecret.secretName,
        RotationSecretName: this.rotationSecret.secretName,
        AuthentikUrl: authentikUrl,
        AdminEmail: takAdminEmail,
        Username: CLOUDTAK_CONSTANTS.DEFAULT_ADMIN_USERNAME,
        GroupName: BREAK_GLASS_GROUP,
        RotatorUsername: 'tak-break-glass-rotator',
        RotatorRoleName: 'tak-break-glass-rotator',
        RotatorGroupName: 'tak-break-glass-rotator',
        RotatorTokenIdentifier: 'tak-break-glass-rotator-token',
        // Run on every deploy, so a missing group membership or token is repaired
        Timestamp: Date.now().toString()
      }
    });

    // ---- Rotation (on demand) ----
    this.rotateFunction = new lambda.Function(this, 'RotateFunction', {
      functionName: `${prefix}-BreakGlassRotate`,
      description: 'Sets a new random password on the CloudTAK break-glass account and in its sealed secret',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(1),
      memorySize: 128,
      role: rotateRole,
      environment: {
        ADMIN_SECRET_NAME: adminPasswordSecret.secretName,
        ROTATION_SECRET_NAME: this.rotationSecret.secretName,
        AUTHENTIK_URL: authentikUrl
      },
      logGroup: new logs.LogGroup(this, 'RotateLogs', {
        retention: logs.RetentionDays.ONE_YEAR,
        removalPolicy: cdk.RemovalPolicy.RETAIN
      }),
      code: lambda.Code.fromInline(fs.readFileSync(path.join(__dirname, '../lambda/break-glass-rotate.cjs'), 'utf8'))
    });

    // ---- The break-glass role: the only reader of the sealed secret ----
    const principals = (settings.roleTrustedPrincipals ?? []).filter(Boolean);
    const trusted: iam.IPrincipal = principals.length > 0
      ? new iam.CompositePrincipal(...principals.map((arn) => new iam.ArnPrincipal(arn)))
      : new iam.AccountRootPrincipal();
    const requireMfa = settings.roleRequireMfa ?? true;
    this.role = new iam.Role(this, 'Role', {
      roleName: `${prefix}-BreakGlass`,
      description: 'Reads the sealed CloudTAK break-glass credential and rotates it',
      assumedBy: requireMfa
        ? new iam.PrincipalWithConditions(trusted, { Bool: { 'aws:MultiFactorAuthPresent': 'true' } })
        : trusted,
      maxSessionDuration: cdk.Duration.hours(1)
    });
    adminPasswordSecret.grantRead(this.role);
    // Read only: decrypting the secret needs no data key
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [kmsKey.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${stack.region}.amazonaws.com` } }
    }));
    this.rotateFunction.grantInvoke(this.role);

    // ---- Sealing and alarms (production) ----
    if (sealed) {
      adminPasswordSecret.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'SealedBreakGlassCredential',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['secretsmanager:GetSecretValue'],
        resources: ['*'],
        conditions: {
          ArnNotEquals: { 'aws:PrincipalArn': [this.role.roleArn, provisionRole.roleArn, rotateRole.roleArn] }
        }
      }));

      const emails = (settings.alertEmails ?? []).filter(Boolean);
      const topic = new sns.Topic(this, 'AlertTopic', {
        topicName: `${prefix}-break-glass`,
        displayName: `TAK.NZ ${stackName} CloudTAK break-glass alert`,
        enforceSSL: true
      });
      emails.forEach((email) => topic.addSubscription(new subscriptions.EmailSubscription(email)));
      if (emails.length === 0) {
        cdk.Annotations.of(this).addWarning(
          'cloudtak.breakGlass.sealed is on but cloudtak.breakGlass.alertEmails is empty: the alarms exist and show in ' +
          'CloudWatch and EventBridge, but nobody is notified.'
        );
      }
      this.alertTopic = topic;

      // The fixed name (not the construct's token), so that the patterns are plain strings. A test ties it to the secret.
      const secretName = `${prefix}/API/Admin-Password`;
      const exceptRoles = [
        `arn:${stack.partition}:sts::${stack.account}:assumed-role/${provisionRole.roleName}/`,
        `arn:${stack.partition}:sts::${stack.account}:assumed-role/${rotateRole.roleName}/`
      ];
      // GetSecretValue is a read-only management event: the rule must be told to receive those, and the account
      // needs a CloudTrail trail that logs management events (read and write) in this Region (base-infra).
      const readRule = new events.Rule(this, 'SecretReadRule', {
        description: 'Alert on every read of the sealed CloudTAK break-glass credential',
        eventPattern: {
          source: ['aws.secretsmanager'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventName: ['GetSecretValue'],
            // The caller may pass the name or the full ARN
            requestParameters: { secretId: [{ prefix: secretName }, { prefix: `arn:${stack.partition}:secretsmanager:${stack.region}:${stack.account}:secret:${secretName}` }] },
            userIdentity: { arn: [{ 'anything-but': { prefix: exceptRoles } }] }
          }
        },
        targets: [new targets.SnsTopic(topic, {
          message: events.RuleTargetInput.fromText(
            `TAK.NZ ${stackName}: the sealed CloudTAK break-glass credential was READ. ` +
            `Caller: ${events.EventField.fromPath('$.detail.userIdentity.arn')}, ` +
            `source address: ${events.EventField.fromPath('$.detail.sourceIPAddress')}, ` +
            `time: ${events.EventField.fromPath('$.detail.eventTime')}. ` +
            'Rotate the credential after use (docs/BREAK_GLASS.md).'
          )
        })]
      });
      (readRule.node.defaultChild as events.CfnRule).state = 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS';

      const policyRule = new events.Rule(this, 'SecretPolicyChangeRule', {
        description: 'Alert on a change to the resource policy that seals the CloudTAK break-glass credential',
        eventPattern: {
          source: ['aws.secretsmanager'],
          detailType: ['AWS API Call via CloudTrail'],
          detail: {
            eventName: ['PutResourcePolicy', 'DeleteResourcePolicy'],
            requestParameters: { secretId: [{ prefix: secretName }, { prefix: `arn:${stack.partition}:secretsmanager:${stack.region}:${stack.account}:secret:${secretName}` }] },
            // A deploy changes the policy through CloudFormation, which is not an alert
            $or: [
              { userIdentity: { invokedBy: [{ 'anything-but': 'cloudformation.amazonaws.com' }] } },
              { userIdentity: { invokedBy: [{ exists: false }] } }
            ]
          }
        },
        targets: [new targets.SnsTopic(topic, {
          message: events.RuleTargetInput.fromText(
            `TAK.NZ ${stackName}: the resource policy of the sealed CloudTAK break-glass credential was CHANGED. ` +
            `Caller: ${events.EventField.fromPath('$.detail.userIdentity.arn')}, ` +
            `action: ${events.EventField.fromPath('$.detail.eventName')}, ` +
            `time: ${events.EventField.fromPath('$.detail.eventTime')}.`
          )
        })]
      });
      void policyRule;

      // Any LDAP bind as the account, successful or not (a failed attempt is as interesting as a good one)
      const ldapLogs = logs.LogGroup.fromLogGroupName(this, 'LdapLogs', LDAP_LOG_GROUP);
      const bindFilter = new logs.MetricFilter(this, 'BindFilter', {
        logGroup: ldapLogs,
        filterPattern: logs.FilterPattern.literal(
          `{ ($.bindDN = "cn=${CLOUDTAK_CONSTANTS.DEFAULT_ADMIN_USERNAME},*") && ($.event = "Bind request") }`
        ),
        metricNamespace: `${prefix}/BreakGlass`,
        metricName: 'LdapBind',
        metricValue: '1',
        defaultValue: 0
      });
      const bindAlarm = new cloudwatch.Alarm(this, 'BindAlarm', {
        alarmName: `${prefix}-BreakGlassLdapBind`,
        alarmDescription: 'The CloudTAK break-glass account bound over LDAP (a sign-in attempt). Rotate after use.',
        metric: bindFilter.metric({ statistic: 'Sum', period: cdk.Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      });
      bindAlarm.addAlarmAction(new cwActions.SnsAction(topic));
    }

    // ---- Outputs for the runbook and the helper script ----
    new cdk.CfnOutput(this, 'BreakGlassRoleArn', { value: this.role.roleArn, description: 'Assume this role (with MFA) to read the break-glass credential' });
    new cdk.CfnOutput(this, 'BreakGlassSecretName', { value: adminPasswordSecret.secretName });
    new cdk.CfnOutput(this, 'BreakGlassRotateFunction', { value: this.rotateFunction.functionName, description: 'Invoke to rotate the break-glass password' });
  }
}
