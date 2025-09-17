import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { ContextEnvironmentConfig } from '../stack-config';

export interface AlarmsProps {
  envConfig: ContextEnvironmentConfig;
  eventsService: ecs.FargateService;
}

export class Alarms extends Construct {
  public readonly highUrgencyTopic: sns.Topic;
  public readonly lowUrgencyTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlarmsProps) {
    super(scope, id);

    const { envConfig, eventsService } = props;

    this.highUrgencyTopic = new sns.Topic(this, 'HighUrgencyAlarmTopic', {
      displayName: `TAK-${envConfig.stackName}-CloudTAK-high-urgency`,
      topicName: `TAK-${envConfig.stackName}-CloudTAK-high-urgency`
    });

    this.lowUrgencyTopic = new sns.Topic(this, 'LowUrgencyAlarmTopic', {
      displayName: `TAK-${envConfig.stackName}-CloudTAK-low-urgency`,
      topicName: `TAK-${envConfig.stackName}-CloudTAK-low-urgency`
    });

    // Create alarm for Events ECS service running count
    new cloudwatch.Alarm(this, 'EventsServiceAlarm', {
      alarmName: `TAK-${envConfig.stackName}-CloudTAK-EventsService`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ServiceName: eventsService.serviceName,
          ClusterName: eventsService.cluster.clusterName
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Average'
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(this.highUrgencyTopic));
  }
}