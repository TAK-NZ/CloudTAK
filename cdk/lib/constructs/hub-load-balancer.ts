import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ContextEnvironmentConfig } from '../stack-config';

export interface HubLoadBalancerProps {
  envConfig: ContextEnvironmentConfig;
  vpc: ec2.IVpc;
  /** SecurityGroups.hubAlb - ingress restricted to the stateless API tasks. */
  hubAlbSecurityGroup: ec2.SecurityGroup;
}

/**
 * Internal ALB fronting the stateful tier's hub RPC port.
 *
 * Mirrors upstream v13.70.0 `cloudformation/lib/stateful.js` (`HubELB`,
 * `HubListener`, `HubRpcTargetGroup`). The stateless API tasks call this to
 * reach the single stateful task for anything needing a TAK Server connection -
 * `submitCots`, `wsNotify`, `wsPresence`, `connectionSync` and friends, defined
 * by the `HubClient` contract in `api/common/hub/index.ts`.
 *
 * Internal and in private subnets: nothing outside the VPC has any business
 * reaching the RPC port. Plain HTTP on 80, because this hop never leaves the
 * VPC and the payloads are already inside the trust boundary.
 *
 * Port 5002 is served directly by node (see `api/stateful/lib/server/hub.ts`,
 * `HUB_RPC_PORT`), not proxied through the container's nginx - which only
 * listens on 5000.
 */
export class HubLoadBalancer extends Construct {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly rpcTargetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: HubLoadBalancerProps) {
    super(scope, id);

    const { envConfig, vpc, hubAlbSecurityGroup } = props;

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'HubELB', {
      vpc,
      internetFacing: false,
      loadBalancerName: `tak-${envConfig.stackName.toLowerCase()}-cloudtak-hub`,
      securityGroup: hubAlbSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
    });

    this.rpcTargetGroup = new elbv2.ApplicationTargetGroup(this, 'HubRpcTargetGroup', {
      vpc,
      port: 5002,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        enabled: true,
        path: '/hub',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3
      }
    });

    this.alb.addListener('HubListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      // Without this CDK opens the listener port to 0.0.0.0/0. Even on an
      // internal ALB that is wider than intended: the only caller is the
      // stateless API tier, and SecurityGroups already grants it explicitly.
      open: false,
      defaultTargetGroups: [this.rpcTargetGroup]
    });
  }
}
