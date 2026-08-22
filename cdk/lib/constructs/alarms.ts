import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
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

    const { envConfig, eventsService, apiService, statefulService, loadBalancer, database } = props;
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
    // ALB errors and latency
    // ---------------------------------------------------------------------
    notify(new cloudwatch.Alarm(this, 'AlarmHTTPCodeELB5XX', {
      alarmName: `TAK-${stackName}-CloudTAK-AlarmHTTPCodeELB5XX-${region}`,
      metric: loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
        period: cdk.Duration.seconds(60),
        statistic: 'Sum'
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    notify(new cloudwatch.Alarm(this, 'AlarmHTTPCodeBackend5XX', {
      alarmName: `TAK-${stackName}-CloudTAK-AlarmHTTPCodeBackend5XX-${region}`,
      metric: loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
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
    notify(new cloudwatch.Alarm(this, 'AlarmHTTPCodeBackend5XXDuration', {
      alarmName: `TAK-${stackName}-CloudTAK-AlarmHTTPCodeBackend5XXDuration-${region}`,
      metric: loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
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
    notify(new cloudwatch.Alarm(this, 'AlarmP99Latency', {
      alarmName: `TAK-${stackName}-CloudTAK-AlarmP99Latency-${region}`,
      metric: loadBalancer.metrics.targetResponseTime({
        period: cdk.Duration.seconds(60),
        statistic: 'p99'
      }),
      threshold: 10,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
    }));

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
  }
}
