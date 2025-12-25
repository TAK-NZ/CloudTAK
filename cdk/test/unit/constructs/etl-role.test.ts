import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { EtlRole } from '../../../lib/constructs/etl-role';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

describe('EtlRole Construct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    
    const kmsKey = new kms.Key(stack, 'TestKey');
    
    new EtlRole(stack, 'TestEtlRole', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      assetBucketName: 'test-bucket',
      kmsKey
    });
    
    template = Template.fromStack(stack);
  });

  test('creates IAM role for Lambda', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: 'sts:AssumeRole'
        }]
      }
    });
  });

  test('grants S3 access to asset bucket', () => {
    const role = template.findResources('AWS::IAM::Role');
    const roleKey = Object.keys(role)[0];
    const statements = role[roleKey].Properties.Policies[0].PolicyDocument.Statement;
    const s3Statement = statements.find((s: any) => s.Action.includes('s3:*'));
    
    expect(s3Statement).toBeDefined();
    expect(s3Statement.Effect).toBe('Allow');
    expect(s3Statement.Resource).toHaveLength(2);
  });

  test('grants KMS decrypt permissions', () => {
    const role = template.findResources('AWS::IAM::Role');
    const roleKey = Object.keys(role)[0];
    const statements = role[roleKey].Properties.Policies[0].PolicyDocument.Statement;
    const kmsStatement = statements.find((s: any) => s.Action.includes('kms:Decrypt'));
    
    expect(kmsStatement).toBeDefined();
    expect(kmsStatement.Effect).toBe('Allow');
    expect(kmsStatement.Action).toContain('kms:Decrypt');
    expect(kmsStatement.Action).toContain('kms:GenerateDataKey');
  });

  test('grants Secrets Manager access', () => {
    const role = template.findResources('AWS::IAM::Role');
    const roleKey = Object.keys(role)[0];
    const statements = role[roleKey].Properties.Policies[0].PolicyDocument.Statement;
    const secretsStatement = statements.find((s: any) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.some((a: string) => a.startsWith('secretsmanager:'));
    });
    
    expect(secretsStatement).toBeDefined();
    expect(secretsStatement.Effect).toBe('Allow');
    const actions = Array.isArray(secretsStatement.Action) ? secretsStatement.Action : [secretsStatement.Action];
    expect(actions).toContain('secretsmanager:Describe*');
    expect(actions).toContain('secretsmanager:Get*');
    expect(actions).toContain('secretsmanager:List*');
  });

  test('has Lambda basic execution role', () => {
    const role = template.findResources('AWS::IAM::Role');
    const roleKey = Object.keys(role)[0];
    const managedPolicies = role[roleKey].Properties.ManagedPolicyArns;
    
    expect(managedPolicies).toBeDefined();
    expect(managedPolicies.length).toBeGreaterThan(0);
    const lambdaPolicy = managedPolicies.find((p: any) => 
      JSON.stringify(p).includes('AWSLambdaBasicExecutionRole')
    );
    expect(lambdaPolicy).toBeDefined();
  });
});
