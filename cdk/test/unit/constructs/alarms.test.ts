import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import { Alarms } from '../../../lib/constructs/alarms';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

/** Build the minimum set of real resources the Alarms construct needs. */
function scaffold(stackId: string, serverless = false) {
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
    writer: serverless
      ? rds.ClusterInstance.serverlessV2('writer')
      : rds.ClusterInstance.provisioned('writer', { instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM) })
  });

  const hubLoadBalancer = new elbv2.ApplicationLoadBalancer(stack, 'TestHubAlb', { vpc, internetFacing: false });

  // Target groups must be attached to a listener for the metrics to carry a
  // LoadBalancer dimension, same as in the real stack.
  const targetGroup = (id: string, lb: elbv2.ApplicationLoadBalancer, port: number) => {
    const tg = new elbv2.ApplicationTargetGroup(stack, id, { vpc, port, protocol: elbv2.ApplicationProtocol.HTTP });
    lb.addListener(`${id}Listener`, { port, protocol: elbv2.ApplicationProtocol.HTTP, open: false, defaultTargetGroups: [tg] });
    return tg;
  };

  const pmtiles = {
    tilesLambda: new lambda.Function(stack, 'TilesLambda', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});')
    }),
    tilesApi: new apigwv2.CfnApi(stack, 'TilesApi', { name: 'tiles', protocolType: 'HTTP' })
  };

  const retention = {
    retentionLogGroup: new logs.LogGroup(stack, 'RetentionLogs'),
    retentionSchedule: new events.Rule(stack, 'RetentionSchedule', { schedule: events.Schedule.rate(Duration.days(1)) })
  };

  return { stack, service, loadBalancer, database, databaseIsServerless: serverless, hubLoadBalancer, targetGroup, pmtiles, retention };
}

describe('Alarms Construct', () => {
  it('creates the events service liveness alarm', () => {
    const { stack, service, loadBalancer, database, databaseIsServerless } = scaffold('TestStack1');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      loadBalancer,
      database,
      databaseIsServerless
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
    const { stack, service, loadBalancer, database, databaseIsServerless } = scaffold('TestStack2');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      loadBalancer,
      database,
      databaseIsServerless
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
    const { stack, service, loadBalancer, database, databaseIsServerless } = scaffold('TestStack3');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      loadBalancer,
      database,
      databaseIsServerless
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'HTTPCode_ELB_5XX_Count',
      AlarmActions: Match.anyValue(),
      InsufficientDataActions: Match.anyValue()
    });
  });

  it('omits stateful service alarms until the hub split is wired', () => {
    const { stack, service, loadBalancer, database, databaseIsServerless } = scaffold('TestStack4');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      loadBalancer,
      database,
      databaseIsServerless
    });

    const alarms = JSON.stringify(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).not.toContain('Stateful-CPUUtilization');
  });

  it('adds stateful service alarms when the hub service is supplied', () => {
    const { stack, service, loadBalancer, database, databaseIsServerless } = scaffold('TestStack5');

    new Alarms(stack, 'TestAlarms', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      eventsService: service('EventsService'),
      apiService: service('ApiService'),
      statefulService: service('StatefulService'),
      loadBalancer,
      database,
      databaseIsServerless
    });

    const alarms = JSON.stringify(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toContain('Stateful-CPUUtilization');
    expect(alarms).toContain('Stateful-MemoryUtilization');
  });

  describe('DbFreeLocalStorageAlarm', () => {
    const build = (stackId: string, serverless: boolean) => {
      const { stack, service, loadBalancer, database, databaseIsServerless } = scaffold(stackId, serverless);
      new Alarms(stack, 'TestAlarms', {
        envConfig: MOCK_CONFIGS.DEV_TEST,
        eventsService: service('EventsService'),
        apiService: service('ApiService'),
        loadBalancer,
        database,
        databaseIsServerless
      });
      return Template.fromStack(stack);
    };

    it('is created for a provisioned cluster', () => {
      const template = build('FreeStorageProvisioned', false);
      template.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/RDS',
        MetricName: 'FreeLocalStorage'
      }, 1);
    });

    it('is absent for Aurora Serverless v2, which does not publish the metric', () => {
      const template = build('FreeStorageServerless', true);
      expect(JSON.stringify(template.findResources('AWS::CloudWatch::Alarm'))).not.toContain('FreeLocalStorage');
      // The other database alarm is unaffected.
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/RDS',
        MetricName: 'CPUUtilization'
      });
    });
  });

  describe('upstream alarm parity', () => {
    function full(stackId: string) {
      const sc = scaffold(stackId);
      new Alarms(sc.stack, 'TestAlarms', {
        envConfig: MOCK_CONFIGS.DEV_TEST,
        eventsService: sc.service('EventsService'),
        apiService: sc.service('ApiService'),
        statefulService: sc.service('StatefulService'),
        loadBalancer: sc.loadBalancer,
        database: sc.database,
        databaseIsServerless: sc.databaseIsServerless,
        hubLoadBalancer: sc.hubLoadBalancer,
        targetGroup: sc.targetGroup('ApiTg', sc.loadBalancer, 5000),
        statefulTargetGroup: sc.targetGroup('StatefulTg', sc.loadBalancer, 5001),
        hubTargetGroup: sc.targetGroup('HubTg', sc.hubLoadBalancer, 5002),
        ...sc.pmtiles,
        ...sc.retention
      });
      return Template.fromStack(sc.stack);
    }

    it('applies the four ALB alarms to the hub ALB with unique names', () => {
      const template = full('ParityStack1');
      const names = Object.values(template.findResources('AWS::CloudWatch::Alarm'))
        .map((r: any) => r.Properties.AlarmName as string);

      for (const n of ['AlarmHTTPCodeELB5XX', 'AlarmHTTPCodeBackend5XX', 'AlarmHTTPCodeBackend5XXDuration', 'AlarmP99Latency']) {
        expect(names).toContain(`TAK-${MOCK_CONFIGS.DEV_TEST.stackName}-CloudTAK-${n}-us-east-1`);
        expect(names).toContain(`TAK-${MOCK_CONFIGS.DEV_TEST.stackName}-CloudTAK-Hub-${n}-us-east-1`);
      }
      expect(new Set(names).size).toBe(names.length);

      // 4 ALB alarms x 2 ALBs: 3 of the 4 count-based metrics per ALB
      template.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HTTPCode_ELB_5XX_Count'
      }, 2);
      template.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'TargetResponseTime',
        ExtendedStatistic: 'p99'
      }, 2);
    });

    it('alarms on HealthyHostCount for the API, stateful and hub target groups', () => {
      const template = full('ParityStack2');
      template.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HealthyHostCount',
        Statistic: 'Minimum',
        Period: 60,
        EvaluationPeriods: 2,
        Threshold: 1,
        ComparisonOperator: 'LessThanThreshold',
        TreatMissingData: 'breaching',
        AlarmActions: Match.anyValue(),
        InsufficientDataActions: Match.anyValue()
      }, 3);
    });

    it('creates PMTiles alarms that notify on alarm only', () => {
      const template = full('ParityStack3');

      for (const metricName of ['Errors', 'Throttles']) {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
          Namespace: 'AWS/Lambda',
          MetricName: metricName,
          Statistic: 'Sum',
          Threshold: 0,
          EvaluationPeriods: 2,
          Period: 60,
          TreatMissingData: 'notBreaching',
          AlarmActions: Match.anyValue(),
          InsufficientDataActions: Match.absent()
        });
      }

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/Lambda',
        MetricName: 'Duration',
        ExtendedStatistic: 'p99',
        Threshold: 50000,
        EvaluationPeriods: 5,
        InsufficientDataActions: Match.absent()
      });

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ApiGateway',
        MetricName: '5xx',
        Statistic: 'Sum',
        Threshold: 1,
        EvaluationPeriods: 2,
        TreatMissingData: 'notBreaching',
        Dimensions: Match.arrayWith([
          { Name: 'ApiId', Value: Match.anyValue() },
          { Name: 'Stage', Value: '$default' }
        ]),
        InsufficientDataActions: Match.absent()
      });

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ApiGateway',
        MetricName: 'IntegrationLatency',
        ExtendedStatistic: 'p99',
        Threshold: 10000,
        EvaluationPeriods: 5,
        TreatMissingData: 'notBreaching',
        Dimensions: Match.arrayWith([{ Name: 'Stage', Value: '$default' }])
      });
    });

    it('creates retention FailedInvocations and log error alarms', () => {
      const template = full('ParityStack4');

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/Events',
        MetricName: 'FailedInvocations',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 0,
        TreatMissingData: 'notBreaching',
        Dimensions: [{ Name: 'RuleName', Value: Match.anyValue() }],
        InsufficientDataActions: Match.absent()
      });

      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        FilterPattern: '"error -"',
        MetricTransformations: [Match.objectLike({
          MetricNamespace: `TAK-${MOCK_CONFIGS.DEV_TEST.stackName}-CloudTAK`,
          MetricName: 'retention-errors',
          MetricValue: '1',
          DefaultValue: 0
        })]
      });

      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: `TAK-${MOCK_CONFIGS.DEV_TEST.stackName}-CloudTAK`,
        MetricName: 'retention-errors',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 0,
        TreatMissingData: 'notBreaching',
        InsufficientDataActions: Match.absent()
      });
    });

    it('still omits the new alarms when the optional props are not supplied', () => {
      const { stack, service, loadBalancer, database, databaseIsServerless } = scaffold('ParityStack5');
      new Alarms(stack, 'TestAlarms', {
        envConfig: MOCK_CONFIGS.DEV_TEST,
        eventsService: service('EventsService'),
        apiService: service('ApiService'),
        loadBalancer,
        database,
        databaseIsServerless
      });
      const alarms = JSON.stringify(Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm'));
      expect(alarms).not.toContain('HealthyHostCount');
      expect(alarms).not.toContain('PMTiles');
      expect(alarms).not.toContain('Retention');
    });
  });
});
