import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { ContextEnvironmentConfig } from '../stack-config';

export interface DashboardProps {
  envConfig: ContextEnvironmentConfig;
  loadBalancer: elbv2.IApplicationLoadBalancer;
  hubLoadBalancer: elbv2.IApplicationLoadBalancer;
  targetGroup: elbv2.IApplicationTargetGroup;
  statefulTargetGroup: elbv2.IApplicationTargetGroup;
  apiService: ecs.FargateService;
  statefulService: ecs.FargateService;
  /** Concrete cluster, not IDatabaseCluster: the Serverless v2 ACU metric is only on the class. */
  database: rds.DatabaseCluster;
}

/** Threshold line shared with the CPU/memory alarms in alarms.ts - keep in sync. */
const SATURATION_THRESHOLD = 80;

/**
 * Operational dashboard, mirroring upstream v13.70.0
 * `cloudformation/lib/dashboard.js`.
 *
 * Written in CDK idiom rather than ported as widget JSON. Hub-aware from the
 * outset: every service-level widget shows the stateless and stateful tiers side
 * by side, because after the split a symptom in one is usually explained by the
 * other.
 *
 * Deliberate deviation: upstream includes an RDS `FreeStorageSpace` widget. That
 * metric is not published for Aurora (see the matching note in alarms.ts), so
 * this uses `FreeLocalStorage` plus ACU utilization, which is what actually
 * moves on Aurora Serverless v2.
 */
export class Dashboard extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: DashboardProps) {
    super(scope, id);

    const {
      envConfig,
      loadBalancer,
      hubLoadBalancer,
      targetGroup,
      statefulTargetGroup,
      apiService,
      statefulService,
      database
    } = props;

    const region = cdk.Stack.of(this).region;

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `TAK-${envConfig.stackName}-CloudTAK-${region}`
    });

    const httpCodes = (alb: elbv2.IApplicationLoadBalancer) => [
      alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_2XX_COUNT, { label: '2xx' }),
      alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_4XX_COUNT, { label: '4xx' }),
      alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { label: '5xx (target)' }),
      alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { label: '5xx (elb)' })
    ];

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'HTTP status - public ALB',
        width: 12,
        left: httpCodes(loadBalancer)
      }),
      new cloudwatch.GraphWidget({
        title: 'HTTP status - internal hub ALB',
        width: 12,
        left: httpCodes(hubLoadBalancer)
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Latency - public ALB',
        width: 12,
        left: [
          loadBalancer.metrics.targetResponseTime({ label: 'avg', statistic: 'Average' }),
          loadBalancer.metrics.targetResponseTime({ label: 'p95', statistic: 'p95' }),
          loadBalancer.metrics.targetResponseTime({ label: 'p99', statistic: 'p99' })
        ]
      }),
      new cloudwatch.GraphWidget({
        title: 'Service capacity',
        width: 12,
        left: [
          targetGroup.metrics.healthyHostCount({ label: 'stateless healthy' }),
          statefulTargetGroup.metrics.healthyHostCount({ label: 'stateful healthy' })
        ]
      })
    );

    // 80% matches the CPU/memory alarm thresholds in alarms.ts.
    const saturationAnnotation = [{
      value: SATURATION_THRESHOLD,
      label: `${SATURATION_THRESHOLD}% (alarm threshold)`,
      color: cloudwatch.Color.RED
    }];

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'CPU utilization',
        width: 12,
        left: [
          apiService.metricCpuUtilization({ label: 'stateless' }),
          statefulService.metricCpuUtilization({ label: 'stateful' })
        ],
        leftAnnotations: saturationAnnotation,
        leftYAxis: { min: 0, max: 100 }
      }),
      new cloudwatch.GraphWidget({
        title: 'Memory utilization',
        width: 12,
        left: [
          apiService.metricMemoryUtilization({ label: 'stateless' }),
          statefulService.metricMemoryUtilization({ label: 'stateful' })
        ],
        leftAnnotations: saturationAnnotation,
        leftYAxis: { min: 0, max: 100 }
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Database - CPU and connections',
        width: 12,
        left: [database.metricCPUUtilization({ label: 'cpu %' })],
        right: [database.metricDatabaseConnections({ label: 'connections' })],
        leftAnnotations: saturationAnnotation
      }),
      new cloudwatch.GraphWidget({
        title: 'Database - Aurora capacity and local storage',
        width: 12,
        // Aurora equivalents of upstream's FreeStorageSpace widget, which does
        // not apply to an Aurora cluster.
        left: [database.metricServerlessDatabaseCapacity({ label: 'ACU' })],
        right: [database.metricFreeLocalStorage({ label: 'free local storage' })]
      })
    );
  }
}
