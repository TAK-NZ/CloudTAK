import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Alarms } from '../../../lib/constructs/alarms';
import { CDKTestHelper } from '../../__helpers__/cdk-test-utils';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

describe('Alarms Construct', () => {
  it('creates CloudWatch alarms', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack1', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    
    const vpc = new ec2.Vpc(stack, 'TestVpc');
    const cluster = new ecs.Cluster(stack, 'TestCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TestTaskDef');
    taskDefinition.addContainer('test', {
      image: ecs.ContainerImage.fromRegistry('nginx'),
      essential: true
    });
    const eventsService = new ecs.FargateService(stack, 'TestService', {
      cluster,
      taskDefinition
    });

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'RunningTaskCount',
      Namespace: 'AWS/ECS'
    });
  });

  it('creates ECS service alarm', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack2', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    
    const vpc = new ec2.Vpc(stack, 'TestVpc');
    const cluster = new ecs.Cluster(stack, 'TestCluster', { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TestTaskDef');
    taskDefinition.addContainer('test', {
      image: ecs.ContainerImage.fromRegistry('nginx'),
      essential: true
    });
    const eventsService = new ecs.FargateService(stack, 'TestService', {
      cluster,
      taskDefinition
    });

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      ComparisonOperator: 'LessThanThreshold',
      EvaluationPeriods: 2,
      Threshold: 1
    });
  });
});