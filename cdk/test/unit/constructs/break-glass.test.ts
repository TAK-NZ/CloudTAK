import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { BreakGlass } from '../../../lib/constructs/break-glass';
import { Secrets } from '../../../lib/constructs/secrets';
import { ContextEnvironmentConfig } from '../../../lib/stack-config';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

function build(breakGlass?: ContextEnvironmentConfig['cloudtak']['breakGlass']) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-west-2' } });
  const kmsKey = new kms.Key(stack, 'Key');
  const envConfig: ContextEnvironmentConfig = {
    ...MOCK_CONFIGS.DEV_TEST,
    cloudtak: { ...MOCK_CONFIGS.DEV_TEST.cloudtak, breakGlass }
  };
  const secrets = new Secrets(stack, 'Secrets', { envConfig, kmsKey });
  new BreakGlass(stack, 'BreakGlass', {
    envConfig,
    adminPasswordSecret: secrets.adminPasswordSecret,
    kmsKey,
    authentikUrl: 'https://account.example.test',
    takAdminEmail: 'admin@example.test'
  });
  return { stack, template: Template.fromStack(stack) };
}

const ROLE_ARN_PREFIX = 'arn:aws:iam::123456789012:role/';

describe('BreakGlass construct', () => {
  describe('everywhere (sealed or not)', () => {
    test('provisions the account and the rotation token on every deploy', () => {
      const { template } = build();
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'TAK-DevTest-CloudTAK-BreakGlassProvision',
        Runtime: 'nodejs22.x'
      });
      const custom = Object.values(template.findResources('AWS::CloudFormation::CustomResource'));
      const props = (custom[0] as any).Properties;
      expect(props).toMatchObject({
        Username: 'ckadmin',
        GroupName: 'tak-break-glass',
        RotatorUsername: 'tak-break-glass-rotator',
        AuthStackName: 'TAK-DevTest-AuthInfra'
      });
      // a new timestamp each deploy, so the group membership and token are repaired
      expect(props.Timestamp).toBeDefined();
    });

    test('has an on-demand rotation function and no schedule', () => {
      const { template } = build();
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'TAK-DevTest-CloudTAK-BreakGlassRotate',
        Timeout: 60,
        Environment: { Variables: Match.objectLike({ AUTHENTIK_URL: 'https://account.example.test' }) }
      });
      template.resourceCountIs('AWS::Events::Rule', 0);
      template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
    });

    test('stores the rotation token in its own secret', () => {
      const { template } = build();
      template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'TAK-DevTest-CloudTAK/API/Admin-Rotation' });
    });

    test('the break-glass role trusts the account and requires MFA, for one hour', () => {
      const { template } = build();
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'TAK-DevTest-CloudTAK-BreakGlass',
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({
            Action: 'sts:AssumeRole',
            Condition: { Bool: { 'aws:MultiFactorAuthPresent': 'true' } },
            Principal: { AWS: Match.anyValue() }
          })]
        }
      });
    });

    test('the break-glass role can invoke the rotation function and read the sealed secret', () => {
      const { template } = build();
      const json = JSON.stringify(template.toJSON());
      expect(json).toContain('lambda:InvokeFunction');
      const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[];
      const forRole = policies.filter((p) => JSON.stringify(p.Properties.Roles).includes('BreakGlassRole'));
      expect(JSON.stringify(forRole)).toContain('secretsmanager:GetSecretValue');
    });

    test('exports the names an operator needs', () => {
      const { template } = build();
      const outputs = Object.keys(template.toJSON().Outputs || {});
      expect(outputs.some((o) => o.includes('BreakGlassRoleArn'))).toBe(true);
      expect(outputs.some((o) => o.includes('BreakGlassRotateFunction'))).toBe(true);
    });
  });

  describe('not sealed (Demo, Test)', () => {
    test('does not deny anyone, and creates no alarms, rules or topic', () => {
      const { template } = build({ sealed: false });
      template.resourceCountIs('AWS::SecretsManager::ResourcePolicy', 0);
      template.resourceCountIs('AWS::Events::Rule', 0);
      template.resourceCountIs('AWS::SNS::Topic', 0);
      template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
      template.resourceCountIs('AWS::Logs::MetricFilter', 0);
    });

    test('defaults to not sealed when the block is absent', () => {
      const { template } = build(undefined);
      template.resourceCountIs('AWS::SecretsManager::ResourcePolicy', 0);
    });
  });

  describe('sealed (production)', () => {
    const sealed = { sealed: true, alertEmails: ['ops@example.test', 'second@example.test'] };

    test('denies GetSecretValue to everyone except the three roles', () => {
      const { template } = build(sealed);
      const policy = Object.values(template.findResources('AWS::SecretsManager::ResourcePolicy'))[0] as any;
      const statement = policy.Properties.ResourcePolicy.Statement.find((s: any) => s.Sid === 'SealedBreakGlassCredential');
      expect(statement.Effect).toBe('Deny');
      expect(statement.Action).toBe('secretsmanager:GetSecretValue');
      expect(statement.Principal).toEqual({ AWS: '*' });
      const allowed = JSON.stringify(statement.Condition.ArnNotEquals['aws:PrincipalArn']);
      expect(allowed).toContain('BreakGlassRole');
      expect(allowed).toContain('ProvisionRole');
      expect(allowed).toContain('RotateRole');
      expect(statement.Condition.ArnNotEquals['aws:PrincipalArn']).toHaveLength(3);
    });

    test('the alarm patterns name the real secret, with fixed names', () => {
      const { template } = build(sealed);
      template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'TAK-DevTest-CloudTAK/API/Admin-Password' });
      const rules = Object.values(template.findResources('AWS::Events::Rule')) as any[];
      for (const rule of rules) {
        const ids = rule.Properties.EventPattern.detail.requestParameters.secretId;
        expect(ids[0]).toEqual({ prefix: 'TAK-DevTest-CloudTAK/API/Admin-Password' });
        expect(JSON.stringify(ids[1].prefix)).toContain(':secretsmanager:us-west-2:123456789012:secret:TAK-DevTest-CloudTAK/API/Admin-Password');
      }
    });

    test('alerts the configured addresses by email', () => {
      const { template } = build(sealed);
      template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'TAK-DevTest-CloudTAK-break-glass' });
      template.resourceCountIs('AWS::SNS::Subscription', 2);
      template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.test' });
    });

    test('warns, but still creates the alarms, when no address is configured', () => {
      const { stack, template } = build({ sealed: true });
      template.resourceCountIs('AWS::SNS::Subscription', 0);
      template.resourceCountIs('AWS::Events::Rule', 2);
      Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('alertEmails is empty'));
    });

    test('alarms on a read of the secret by anyone but the two functions, including read-only events', () => {
      const { template } = build(sealed);
      const rules = Object.values(template.findResources('AWS::Events::Rule')) as any[];
      const read = rules.find((r) => JSON.stringify(r.Properties.EventPattern).includes('GetSecretValue'));
      expect(read.Properties.State).toBe('ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS');
      const detail = read.Properties.EventPattern.detail;
      // the name and the full ARN, since the caller may use either
      expect(detail.requestParameters.secretId).toHaveLength(2);
      const except = JSON.stringify(detail.userIdentity.arn);
      expect(except).toContain('anything-but');
      expect(except).toContain('BreakGlassProvision');
      expect(except).toContain('BreakGlassRotate');
      // the break-glass role is not excluded: reading is the event to alarm on
      expect(except).not.toContain('CloudTAK-BreakGlass/');
    });

    test('alarms on a change to the secret policy, except one made by CloudFormation', () => {
      const { template } = build(sealed);
      const rules = Object.values(template.findResources('AWS::Events::Rule')) as any[];
      const change = rules.find((r) => JSON.stringify(r.Properties.EventPattern).includes('PutResourcePolicy'));
      expect(change.Properties.EventPattern.detail.eventName).toEqual(['PutResourcePolicy', 'DeleteResourcePolicy']);
      expect(JSON.stringify(change.Properties.EventPattern.detail)).toContain('cloudformation.amazonaws.com');
    });

    test('alarms on any LDAP bind as the account, a failed one included', () => {
      const { template } = build(sealed);
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        LogGroupName: 'LDAP',
        FilterPattern: '{ ($.bindDN = "cn=ckadmin,*") && ($.event = "Bind request") }'
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'TAK-DevTest-CloudTAK-BreakGlassLdapBind',
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching'
      });
    });
  });

  describe('configuration', () => {
    test('trusts only the configured principals', () => {
      const { template } = build({ roleTrustedPrincipals: [`${ROLE_ARN_PREFIX}Ops`, `${ROLE_ARN_PREFIX}Lead`] });
      const role = Object.values(template.findResources('AWS::IAM::Role')).find((r: any) => r.Properties.RoleName === 'TAK-DevTest-CloudTAK-BreakGlass') as any;
      const principals = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
      expect(principals).toContain(`${ROLE_ARN_PREFIX}Ops`);
      expect(principals).toContain(`${ROLE_ARN_PREFIX}Lead`);
      expect(principals).not.toContain(':root');
    });

    test('drops the MFA condition when it is switched off (Identity Center roles)', () => {
      const { template } = build({ roleRequireMfa: false, roleTrustedPrincipals: [`${ROLE_ARN_PREFIX}Ops`] });
      const role = Object.values(template.findResources('AWS::IAM::Role')).find((r: any) => r.Properties.RoleName === 'TAK-DevTest-CloudTAK-BreakGlass') as any;
      expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).not.toContain('MultiFactorAuthPresent');
    });
  });
});
