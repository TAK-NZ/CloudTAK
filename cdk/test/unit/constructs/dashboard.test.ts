import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Dashboard } from '../../../lib/constructs/dashboard';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

function scaffold(stackId: string) {
  const app = new App();
  const stack = new Stack(app, stackId, {
    env: { account: '123456789012', region: 'us-east-1' }
  });

  const vpc = new ec2.Vpc(stack, 'Vpc');
  const cluster = new ecs.Cluster(stack, 'Cluster', { vpc });

  const service = (id: string) => {
    const taskDefinition = new ecs.FargateTaskDefinition(stack, `${id}TaskDef`);
    taskDefinition.addContainer('test', {
      image: ecs.ContainerImage.fromRegistry('nginx'),
      essential: true
    });
    return new ecs.FargateService(stack, id, { cluster, taskDefinition });
  };

  const loadBalancer = new elbv2.ApplicationLoadBalancer(stack, 'Alb', { vpc, internetFacing: true });
  const hubLoadBalancer = new elbv2.ApplicationLoadBalancer(stack, 'HubAlb', { vpc, internetFacing: false });

  const targetGroup = new elbv2.ApplicationTargetGroup(stack, 'Tg', { vpc, port: 5000, protocol: elbv2.ApplicationProtocol.HTTP });
  const statefulTargetGroup = new elbv2.ApplicationTargetGroup(stack, 'StatefulTg', { vpc, port: 5000, protocol: elbv2.ApplicationProtocol.HTTP });

  // healthyHostCount() requires the target group to be attached to a listener.
  loadBalancer.addListener('Http', { port: 80, defaultTargetGroups: [targetGroup] });
  hubLoadBalancer.addListener('Http', { port: 80, defaultTargetGroups: [statefulTargetGroup] });

  const database = new rds.DatabaseCluster(stack, 'Db', {
    engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_4 }),
    vpc,
    writer: rds.ClusterInstance.serverlessV2('writer')
  });

  new Dashboard(stack, 'Dashboard', {
    envConfig: MOCK_CONFIGS.DEV_TEST,
    loadBalancer,
    hubLoadBalancer,
    targetGroup,
    statefulTargetGroup,
    apiService: service('ApiService'),
    statefulService: service('StatefulService'),
    database
  });

  return Template.fromStack(stack);
}

describe('Dashboard Construct', () => {
  it('creates one dashboard named per stack and region', () => {
    const template = scaffold('D1');
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'TAK-DevTest-CloudTAK-us-east-1'
    });
  });

  it('renders every widget, with both tiers side by side', () => {
    const dashboards = scaffold('D2').findResources('AWS::CloudWatch::Dashboard');
    const body = JSON.stringify(Object.values(dashboards)[0].Properties.DashboardBody);

    for (const title of [
      'HTTP status - public ALB',
      'HTTP status - internal hub ALB',
      'Latency - public ALB',
      'Service capacity',
      'CPU utilization',
      'Memory utilization',
      'Database - CPU and connections',
      'Database - Aurora capacity and local storage'
    ]) {
      expect(body).toContain(title);
    }

    // Every service-level widget contrasts the stateless and stateful tiers.
    expect(body).toContain('stateless');
    expect(body).toContain('stateful');
  });

  it('uses Aurora storage metrics, not upstream FreeStorageSpace', () => {
    const dashboards = scaffold('D3').findResources('AWS::CloudWatch::Dashboard');
    const body = JSON.stringify(Object.values(dashboards)[0].Properties.DashboardBody);

    expect(body).toContain('ServerlessDatabaseCapacity');
    expect(body).toContain('FreeLocalStorage');
    expect(body).not.toContain('FreeStorageSpace');
  });
});
