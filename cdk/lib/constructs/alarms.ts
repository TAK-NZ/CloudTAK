import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import { ContextEnvironmentConfig } from '../stack-config';

export interface AlarmsProps {
  envConfig: ContextEnvironmentConfig;
  eventsService: ecs.FargateService;

  /** Stateless API service - CPU/memory alarms (upstream's `Service`). */
  apiService: ecs.FargateService;

  /**
   * Stateful "hub" service. Optional so the construct still works before the
   * hub split lands. Arguably more important to alarm on than the API service:
   * single task, no autoscaling, owns every TAK Server connection.
   */
  statefulService?: ecs.FargateService;

  /** ALB behind the API - 5XX and latency alarms. */
  loadBalancer: elbv2.IApplicationLoadBalancer;

  /** Aurora PostgreSQL cluster - CPU and local-storage alarms. */
  database: rds.IDatabaseCluster;

  /** Internal hub ALB - same four ALB alarms as the main ALB. */
  hubLoadBalancer?: elbv2.IApplicationLoadBalancer;

  /** API target group - HealthyHostCount alarm. */
  targetGroup?: elbv2.IApplicationTargetGroup;

  /** Stateful target group (port 5000) - HealthyHostCount alarm. */
  statefulTargetGroup?: elbv2.IApplicationTargetGroup;

  /** Hub RPC target group (port 5002) - HealthyHostCount alarm. */
  hubTargetGroup?: elbv2.IApplicationTargetGroup;

  /** PMTiles Lambda - Errors, Throttles and Duration alarms. */
  tilesLambda?: lambda.IFunction;

  /** PMTiles HTTP API - 5xx and IntegrationLatency alarms. */
  tilesApi?: apigwv2.CfnApi;

  /** Retention task log group - `error -` metric filter and alarm. */
  retentionLogGroup?: logs.ILogGroup;

  /** Retention EventBridge rule - FailedInvocations alarm. */
  retentionSchedule?: events.IRule;
}

/**
 * CloudWatch alarms, all routed to the high-urgency SNS topic.
 *
 * Mirrors upstream v13.70.0 `cloudformation/lib/alarms.js`, which hand-wrote
 * these after dropping the `@openaddresses/batch-alarms` dependency. Our CDK
 * never used that package, so before this construct existed these were simply
 * absent - a real monitoring gap rather than a refactor to mirror.
 *
 * Upstream sets both AlarmActions and InsufficientDataActions to the
 * high-urgency topic; we match that, with one deliberate exception noted on the
 * local-storage alarm below.
 */
export class Alarms extends Construct {
  public readonly highUrgencyTopic: sns.Topic;
  public readonly lowUrgencyTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlarmsProps) {
    super(scope, id);

    const {
      envConfig, eventsService, apiService, statefulService, loadBalancer, database,
      hubLoadBalancer, targetGroup, statefulTargetGroup, hubTargetGroup,
      tilesLambda, tilesApi, retentionLogGroup, retentionSchedule
    } = props;
    const stackName = envConfig.stackName;
    const region = cdk.Stack.of(this).region;

    this.highUrgencyTopic = new sns.Topic(this, 'HighUrgencyAlarmTopic', {
      displayName: `TAK-${stackName}-CloudTAK-high-urgency`,
      topicName: `TAK-${stackName}-CloudTAK-high-urgency`
    });

    this.lowUrgencyTopic = new sns.Topic(this, 'LowUrgencyAlarmTopic', {
      displayName: `TAK-${stackName}-CloudTAK-low-urgency`,
      topicName: `TAK-${stackName}-CloudTAK-low-urgency`
    });

    const highUrgency = new cwActions.SnsAction(this.highUrgencyTopic);

    /** Wire an alarm to the high-urgency topic for both alarm and insufficient-data. */
    const notify = (alarm: cloudwatch.Alarm): cloudwatch.Alarm => {
      alarm.addAlarmAction(highUrgency);
      alarm.addInsufficientDataAction(highUrgency);
      return alarm;
    };

    // ---------------------------------------------------------------------
    // Events service liveness (pre-existing, fork-local)
    //
    // Uses CPUUtilization SampleCount as a proxy for "is anything running":
    // RunningTaskCount needs Container Insights, which is not enabled. When the
    // service has no running tasks ECS stops publishing CPU metrics entirely,
    // so BREACHING on missing data is what actually detects the outage.
    // ---------------------------------------------------------------------
    new cloudwatch.Alarm(this, 'EventsServiceAlarm', {
      alarmName: `TAK-${stackName}-CloudTAK-EventsService`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'CPUUtilization',
        dimensionsMap: {
          ServiceName: eventsService.serviceName,
          ClusterName: eventsService.cluster.clusterName
        },
        period: cdk.Duration.minutes(5),
        statistic: 'SampleCount'
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING
    }).addAlarmAction(highUrgency);

    // ---------------------------------------------------------------------
    // ECS service saturation - upstream BatchELBCpuAlarm / BatchELBMemoryAlarm
    // ---------------------------------------------------------------------
    notify(new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
      alarmName: `TAK-${stackName}-CloudTAK-CPUUtilization-${region}`,
      metric: apiService.metricCpuUtilization({
        period: cdk.Duration.seconds(60),
        statistic: 'Average'
      }),
      threshold: 80,
      evaluationPeriods: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
    }));

    notify(new cloudwatch.Alarm(this, 'ApiMemoryAlarm', {
      alarmName: `TAK-${stackName}-CloudTAK-MemoryUtilization-${region}`,
      metric: apiService.metricMemoryUtilization({
        period: cdk.Duration.seconds(60),
        statistic: 'Average'
      }),
      threshold: 80,
      evaluationPeriods: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
    }));

    // Fork-local addition. Upstream alarms only on their stateless Service, but
    // the stateful tier is a single task with no autoscaling that owns every TAK
    // Server connection, so saturation there is at least as urgent.
    if (statefulService) {
      notify(new cloudwatch.Alarm(this, 'StatefulCpuAlarm', {
        alarmName: `TAK-${stackName}-CloudTAK-Stateful-CPUUtilization-${region}`,
        metric: statefulService.metricCpuUtilization({
          period: cdk.Duration.seconds(60),
          statistic: 'Average'
        }),
        threshold: 80,
        evaluationPeriods: 10,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
      }));

      notify(new cloudwatch.Alarm(this, 'StatefulMemoryAlarm', {
        alarmName: `TAK-${stackName}-CloudTAK-Stateful-MemoryUtilization-${region}`,
        metric: statefulService.metricMemoryUtilization({
          period: cdk.Duration.seconds(60),
          statistic: 'Average'
        }),
        threshold: 80,
        evaluationPeriods: 10,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
      }));
    }

    // ---------------------------------------------------------------------
    // ALB errors and latency - upstream `elbAlarms`, applied to both ALBs.
    // The main ALB keeps its original construct ids and alarm names; the hub
    // ALB gets a `Hub` prefix on both so nothing collides.
    // ---------------------------------------------------------------------
    const elbAlarms = (idPrefix: string, namePrefix: string, alb: elbv2.IApplicationLoadBalancer): void => {
      notify(new cloudwatch.Alarm(this, `${idPrefix}AlarmHTTPCodeELB5XX`, {
        alarmName: `TAK-${stackName}-CloudTAK-${namePrefix}AlarmHTTPCodeELB5XX-${region}`,
        metric: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
          period: cdk.Duration.seconds(60),
          statistic: 'Sum'
        }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));

      notify(new cloudwatch.Alarm(this, `${idPrefix}AlarmHTTPCodeBackend5XX`, {
        alarmName: `TAK-${stackName}-CloudTAK-${namePrefix}AlarmHTTPCodeBackend5XX-${region}`,
        metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
          period: cdk.Duration.seconds(60),
          statistic: 'Sum'
        }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));

      // Same metric as above on a longer window: catches a sustained low rate of
      // 5XXs that the 2 x 60s alarm would flap on.
      notify(new cloudwatch.Alarm(this, `${idPrefix}AlarmHTTPCodeBackend5XXDuration`, {
        alarmName: `TAK-${stackName}-CloudTAK-${namePrefix}AlarmHTTPCodeBackend5XXDuration-${region}`,
        metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
          period: cdk.Duration.seconds(300),
          statistic: 'Sum'
        }),
        threshold: 5,
        evaluationPeriods: 4,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));

      // Upstream deliberately leaves treatMissingData unset here (defaults to
      // missing), so absence of traffic does not read as high latency.
      notify(new cloudwatch.Alarm(this, `${idPrefix}AlarmP99Latency`, {
        alarmName: `TAK-${stackName}-CloudTAK-${namePrefix}AlarmP99Latency-${region}`,
        metric: alb.metrics.targetResponseTime({
          period: cdk.Duration.seconds(60),
          statistic: 'p99'
        }),
        threshold: 10,
        evaluationPeriods: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
      }));
    };

    elbAlarms('', '', loadBalancer);
    if (hubLoadBalancer) elbAlarms('Hub', 'Hub-', hubLoadBalancer);

    // ---------------------------------------------------------------------
    // Target group health - upstream `healthyHostAlarm`. Missing data means no
    // targets are registered at all, which is exactly the outage, so BREACHING.
    // ---------------------------------------------------------------------
    const healthyHostAlarm = (idPrefix: string, namePrefix: string, tg: elbv2.IApplicationTargetGroup): void => {
      notify(new cloudwatch.Alarm(this, `${idPrefix}HealthyHostAlarm`, {
        alarmName: `TAK-${stackName}-CloudTAK-${namePrefix}HealthyHostCount-${region}`,
        metric: tg.metrics.healthyHostCount({
          period: cdk.Duration.seconds(60),
          statistic: 'Minimum'
        }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING
      }));
    };

    if (targetGroup) healthyHostAlarm('Api', '', targetGroup);
    if (statefulTargetGroup) healthyHostAlarm('Stateful', 'Stateful-', statefulTargetGroup);
    if (hubTargetGroup) healthyHostAlarm('Hub', 'Hub-', hubTargetGroup);

    // ---------------------------------------------------------------------
    // Database
    // ---------------------------------------------------------------------
    notify(new cloudwatch.Alarm(this, 'DbCpuAlarm', {
      alarmName: `TAK-${stackName}-CloudTAK-DBCPUUtilization-${region}`,
      metric: database.metricCPUUtilization({
        period: cdk.Duration.seconds(60),
        statistic: 'Average'
      }),
      threshold: 80,
      evaluationPeriods: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
    }));

    // DELIBERATE DEVIATION FROM UPSTREAM.
    //
    // Upstream alarms on `FreeStorageSpace < 10 GiB`. That metric is not
    // published for Aurora - it belongs to non-Aurora RDS instances - and both
    // upstream and this stack run aurora-postgresql. On Aurora the alarm would
    // sit in INSUFFICIENT_DATA permanently and, because upstream also routes
    // insufficient-data to the high-urgency topic, page continuously. Aurora
    // storage also auto-scales, so "free storage" is not the operational risk it
    // is for a fixed-size volume.
    //
    // `FreeLocalStorage` is the Aurora equivalent that can actually be exhausted
    // (temp tables, sorts). Note it is NOT wired to insufficient-data: Aurora
    // Serverless v2 stops publishing it while scaled to zero ACU.
    //
    // The 1 GiB threshold is a conservative starting point, not a measured one -
    // validate it against observed FreeLocalStorage on the demo stack and tune.
    new cloudwatch.Alarm(this, 'DbFreeLocalStorageAlarm', {
      alarmName: `TAK-${stackName}-CloudTAK-DBFreeLocalStorage-${region}`,
      metric: database.metricFreeLocalStorage({
        period: cdk.Duration.seconds(60),
        statistic: 'Average'
      }),
      threshold: 1 * 1024 * 1024 * 1024,
      evaluationPeriods: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }).addAlarmAction(highUrgency);

    // ---------------------------------------------------------------------
    // PMTiles - upstream PMTilesLambda* / PMTilesApi* alarms.
    //
    // Mirrors upstream: alarm action only, no InsufficientData action, so an
    // idle function or API does not page. Missing data is notBreaching.
    // ---------------------------------------------------------------------
    const alarmOnly = (alarm: cloudwatch.Alarm): cloudwatch.Alarm => {
      alarm.addAlarmAction(highUrgency);
      return alarm;
    };

    if (tilesLambda) {
      alarmOnly(new cloudwatch.Alarm(this, 'PMTilesLambdaErrorsAlarm', {
        alarmName: `TAK-${stackName}-CloudTAK-PMTilesLambdaErrors-${region}`,
        metric: tilesLambda.metricErrors({ period: cdk.Duration.seconds(60), statistic: 'Sum' }),
        threshold: 0,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));

      alarmOnly(new cloudwatch.Alarm(this, 'PMTilesLambdaThrottlesAlarm', {
        alarmName: `TAK-${stackName}-CloudTAK-PMTilesLambdaThrottles-${region}`,
        metric: tilesLambda.metricThrottles({ period: cdk.Duration.seconds(60), statistic: 'Sum' }),
        threshold: 0,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));

      alarmOnly(new cloudwatch.Alarm(this, 'PMTilesLambdaDurationAlarm', {
        alarmName: `TAK-${stackName}-CloudTAK-PMTilesLambdaDuration-${region}`,
        metric: tilesLambda.metricDuration({ period: cdk.Duration.seconds(60), statistic: 'p99' }),
        threshold: 50000,
        evaluationPeriods: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));
    }

    if (tilesApi) {
      // API Gateway v2 HTTP API metrics are keyed by ApiId + Stage; the stack
      // deploys the single `$default` stage.
      const apiMetric = (metricName: string, statistic: string): cloudwatch.Metric => new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        dimensionsMap: { ApiId: tilesApi.ref, Stage: '$default' },
        period: cdk.Duration.seconds(60),
        statistic
      });

      alarmOnly(new cloudwatch.Alarm(this, 'PMTilesApi5XXAlarm', {
        alarmName: `TAK-${stackName}-CloudTAK-PMTilesApi5XX-${region}`,
        metric: apiMetric('5xx', 'Sum'),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));

      alarmOnly(new cloudwatch.Alarm(this, 'PMTilesApiLatencyAlarm', {
        alarmName: `TAK-${stackName}-CloudTAK-PMTilesApiP99Latency-${region}`,
        metric: apiMetric('IntegrationLatency', 'p99'),
        threshold: 10000,
        evaluationPeriods: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));
    }

    // ---------------------------------------------------------------------
    // Retention - upstream RetentionFailedInvocationsAlarm / RetentionErrorsAlarm.
    // The task logs `error - ...` lines (tasks/retention/src/index.ts).
    // ---------------------------------------------------------------------
    if (retentionSchedule) {
      alarmOnly(new cloudwatch.Alarm(this, 'RetentionFailedInvocationsAlarm', {
        alarmName: `TAK-${stackName}-CloudTAK-RetentionFailedInvocations-${region}`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Events',
          metricName: 'FailedInvocations',
          dimensionsMap: { RuleName: retentionSchedule.ruleName },
          period: cdk.Duration.seconds(300),
          statistic: 'Sum'
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));
    }

    if (retentionLogGroup) {
      const retentionErrors = new logs.MetricFilter(this, 'RetentionErrorMetricFilter', {
        logGroup: retentionLogGroup,
        filterPattern: logs.FilterPattern.literal('"error -"'),
        metricNamespace: `TAK-${stackName}-CloudTAK`,
        metricName: 'retention-errors',
        metricValue: '1',
        defaultValue: 0,
        unit: cloudwatch.Unit.COUNT
      });

      alarmOnly(new cloudwatch.Alarm(this, 'RetentionErrorsAlarm', {
        alarmName: `TAK-${stackName}-CloudTAK-RetentionErrors-${region}`,
        metric: retentionErrors.metric({ period: cdk.Duration.seconds(300), statistic: 'Sum' }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      }));
    }
  }
}
