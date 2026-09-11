import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CloudTakApi } from '../../../lib/constructs/cloudtak-api';
import { CDKTestHelper } from '../../__helpers__/cdk-test-utils';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

// The plain "creates a FARGATE service / awsvpc task definition" restatements
// were removed — the full-stack synth in stack-synth.test.ts already exercises
// the API service. What remains is the one wiring detail the synth does not
// assert: the ETL repository name injected into the container environment,
// which the ETL layer subsystem reads.
describe('CloudTakApi Construct', () => {
  it('sets ETL ECR repository name in environment variables', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack3', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    const infrastructure = CDKTestHelper.createMockInfrastructure(stack);
    const { vpc, ecsCluster, ecsSecurityGroup } = infrastructure;
    const ecrRepository = CDKTestHelper.createMockEcrRepository(stack);
    
    const targetGroup = new elbv2.ApplicationTargetGroup(stack, 'TestTargetGroup', {
      vpc,
      port: 5000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP
    });

    const signingSecret3 = secretsmanager.Secret.fromSecretCompleteArn(stack, 'SigningSecret3', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret3-AbCdEf');
    const adminSecret3 = secretsmanager.Secret.fromSecretCompleteArn(stack, 'AdminSecret3', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:admin-secret3-AbCdEf');
    const dbSecret3 = secretsmanager.Secret.fromSecretCompleteArn(stack, 'DatabaseSecret3', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-secret3-AbCdEf');
    const geofenceSecret3 = secretsmanager.Secret.fromSecretCompleteArn(stack, 'GeofenceSecret3', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:geofence-secret3-AbCdEf');

    const etlEcrRepository3 = CDKTestHelper.createMockEcrRepository(stack, 'EtlEcrRepository3');

    new CloudTakApi(stack, 'TestCloudTakApi', {
      environment: 'dev-test',
      envConfig: MOCK_CONFIGS.DEV_TEST,
      ecsCluster,
      vpc,
      ecsSecurityGroup,
      mediaSecurityGroup: ecsSecurityGroup,
      ecrRepository,
      etlEcrRepository: etlEcrRepository3,
      albTargetGroup: targetGroup,
      assetBucketName: 'test-bucket',
      serviceUrl: 'https://test.example.com',
      signingSecret: signingSecret3,
      adminPasswordSecret: adminSecret3,
      geofenceSecret: geofenceSecret3,
      databaseHostname: 'db.example.com',
      databaseSecret: dbSecret3,
      connectionStringSecret: dbSecret3
    });

    const template = Template.fromStack(stack);
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const taskDef = Object.values(taskDefs)[0];
    const containerDef = taskDef.Properties.ContainerDefinitions[0];
    const envVars = containerDef.Environment;
    
    expect(envVars).toContainEqual({
      Name: 'ECR_TASKS_REPOSITORY_NAME',
      Value: 'mock-ecr-repository'
    });
  });
});