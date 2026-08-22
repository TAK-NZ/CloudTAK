import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Alarms } from '../../../lib/constructs/alarms';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

/** Build the minimum set of real resources the Alarms construct needs. */
function scaffold(stackId: string) {
  const app = new App();
  const stack = new Stack(app, stackId, {
    env: { account: '123456789012', region: 'us-east-1' }
  });

  const vpc = new ec2.Vpc(stack, 'TestVpc');
  const cluster = new ecs.Cluster(stack, 'TestCluster', { vpc });

  const service = (id: string) => {
    const taskDefinition = new ecs.FargateTaskDefinition(stack, `${id}TaskDef`);
    taskDefinition.addContainer('test', {
      image: ecs.ContainerImage.fromRegistry('nginx'),
      essential: true
    });
    return new ecs.FargateService(stack, id, { cluster, taskDefinition });
  };

  const loadBalancer = new elbv2.ApplicationLoadBalancer(stack, 'TestAlb', { vpc, internetFacing: true });

  const database = new rds.DatabaseCluster(stack, 'TestDb', {
    engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_4 }),
    vpc,
    writer: rds.ClusterInstance.serverlessV2('writer')
  });

  return { stack, service, loadBalancer, database };
}

describe('Alarms Construct', () => {
  it('creates the events service liveness alarm', () => {
    const { stack, service, loadBalancer, database } = scaffold('TestStack1');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      loadBalancer,
      database
    });

    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'CPUUtilization',
      Namespace: 'AWS/ECS',
      Statistic: 'SampleCount',
      ComparisonOperator: 'LessThanThreshold',
      EvaluationPeriods: 2,
      Threshold: 1,
      TreatMissingData: 'breaching'
    });
  });

  it('creates the upstream ELB, ECS and RDS alarms', () => {
    const { stack, service, loadBalancer, database } = scaffold('TestStack2');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      loadBalancer,
      database
    });

    const template = Template.fromStack(stack);

    // API service saturation
    for (const metricName of ['CPUUtilization', 'MemoryUtilization']) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ECS',
        MetricName: metricName,
        Statistic: 'Average',
        Threshold: 80,
        EvaluationPeriods: 10,
        Period: 60,
        ComparisonOperator: 'GreaterThanThreshold'
      });
    }

    // ELB 5XX - both the fast and the sustained window
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApplicationELB',
      MetricName: 'HTTPCode_ELB_5XX_Count',
      Threshold: 1,
      EvaluationPeriods: 2,
      Period: 60,
      TreatMissingData: 'notBreaching'
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApplicationELB',
      MetricName: 'HTTPCode_Target_5XX_Count',
      Threshold: 1,
      EvaluationPeriods: 2,
      Period: 60
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApplicationELB',
      MetricName: 'HTTPCode_Target_5XX_Count',
      Threshold: 5,
      EvaluationPeriods: 4,
      Period: 300
    });

    // p99 latency uses an extended statistic and leaves missing data unset
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApplicationELB',
      MetricName: 'TargetResponseTime',
      ExtendedStatistic: 'p99',
      Threshold: 10,
      EvaluationPeriods: 5,
      TreatMissingData: Match.absent()
    });

    // Database
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/RDS',
      MetricName: 'CPUUtilization',
      Threshold: 80,
      EvaluationPeriods: 10,
      ComparisonOperator: 'GreaterThanThreshold'
    });

    // Deliberate deviation: FreeLocalStorage, not upstream's FreeStorageSpace,
    // which Aurora does not publish.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/RDS',
      MetricName: 'FreeLocalStorage',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 1073741824,
      EvaluationPeriods: 10,
      TreatMissingData: 'notBreaching'
    });
    expect(
      JSON.stringify(template.findResources('AWS::CloudWatch::Alarm'))
    ).not.toContain('FreeStorageSpace');
  });

  it('routes alarms to the high urgency topic, including insufficient data', () => {
    const { stack, service, loadBalancer, database } = scaffold('TestStack3');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      loadBalancer,
      database
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'HTTPCode_ELB_5XX_Count',
      AlarmActions: Match.anyValue(),
      InsufficientDataActions: Match.anyValue()
    });
  });

  it('omits stateful service alarms until the hub split is wired', () => {
    const { stack, service, loadBalancer, database } = scaffold('TestStack4');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      loadBalancer,
      database
    });

    const alarms = JSON.stringify(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).not.toContain('Stateful-CPUUtilization');
  });

  it('adds stateful service alarms when the hub service is supplied', () => {
    const { stack, service, loadBalancer, database } = scaffold('TestStack5');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      statefulService: service('StatefulService'),
      loadBalancer,
      database
    });

    const alarms = JSON.stringify(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toContain('Stateful-CPUUtilization');
    expect(alarms).toContain('Stateful-MemoryUtilization');
  });
});
