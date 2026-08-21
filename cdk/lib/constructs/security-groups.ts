import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ContextEnvironmentConfig } from '../stack-config';
import { createBaseImportValue, BASE_EXPORT_NAMES } from '../cloudformation-imports';

export interface SecurityGroupsProps {
  vpc: ec2.IVpc;
  envConfig: ContextEnvironmentConfig;
  vpcCidrIpv4?: string; // Optional override for VPC IPv4 CIDR
  vpcCidrIpv6?: string; // Optional override for VPC IPv6 CIDR
}

export class SecurityGroups extends Construct {
  public readonly database: ec2.SecurityGroup;
  public readonly ecs: ec2.SecurityGroup;
  public readonly alb: ec2.SecurityGroup;
  public readonly media: ec2.SecurityGroup;

  /**
   * Stateful ("hub") service tasks. Accepts WebSocket traffic from the public
   * ALB on 5000 and hub RPC from the internal hub ALB on 5002.
   */
  public readonly stateful: ec2.SecurityGroup;

  /** Internal hub ALB. Only the stateless API tasks may reach it. */
  public readonly hubAlb: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SecurityGroupsProps) {
    super(scope, id);

    const { vpc, envConfig, vpcCidrIpv4: providedVpcCidrIpv4, vpcCidrIpv6: providedVpcCidrIpv6 } = props;
    
    // Import VPC CIDRs from BaseInfra if not provided
    const vpcCidrIpv4 = providedVpcCidrIpv4 || 
      cdk.Fn.importValue(createBaseImportValue(envConfig.stackName, BASE_EXPORT_NAMES.VPC_CIDR_IPV4));
      
    const vpcCidrIpv6 = providedVpcCidrIpv6 || 
      cdk.Fn.importValue(createBaseImportValue(envConfig.stackName, BASE_EXPORT_NAMES.VPC_CIDR_IPV6));

    this.alb = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: vpc,
      description: `TAK-${envConfig.stackName}-CloudTAK ALB Security Group`,
      allowAllOutbound: false
    });

    this.alb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    this.alb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    this.alb.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP IPv6');
    this.alb.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS IPv6');

    this.ecs = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc: vpc,
      description: `TAK-${envConfig.stackName}-CloudTAK ECS Security Group`,
      allowAllOutbound: false
    });

    this.ecs.addIngressRule(this.alb, ec2.Port.tcp(5000), 'ALB to ECS');

    // Stateful ("hub") tier, and the internal ALB that fronts its RPC port.
    // Both are declared before any rules are added because they reference each
    // other: the hub ALB egresses to the stateful tasks, and the stateful tasks
    // accept ingress from the hub ALB.
    this.stateful = new ec2.SecurityGroup(this, 'StatefulServiceSecurityGroup', {
      vpc: vpc,
      description: `TAK-${envConfig.stackName}-CloudTAK Stateful Service Security Group`,
      allowAllOutbound: false
    });

    this.hubAlb = new ec2.SecurityGroup(this, 'HubELBSecurityGroup', {
      vpc: vpc,
      description: `TAK-${envConfig.stackName}-CloudTAK Internal Hub ALB Security Group`,
      allowAllOutbound: false
    });

    // WebSocket traffic arrives from the public ALB on 5000 (nginx), hub RPC
    // from the internal ALB on 5002 (node, not proxied through nginx).
    this.stateful.addIngressRule(this.alb, ec2.Port.tcp(5000), 'ALB WebSocket traffic to stateful');
    this.stateful.addIngressRule(this.hubAlb, ec2.Port.tcp(5002), 'Hub RPC from internal hub ALB');

    // Only the stateless API tasks may call the hub.
    this.hubAlb.addIngressRule(this.ecs, ec2.Port.tcp(80), 'Hub RPC from stateless API tasks');

    this.database = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: vpc,
      description: `TAK-${envConfig.stackName}-CloudTAK Database Security Group`,
      allowAllOutbound: false
    });

    this.database.addIngressRule(this.ecs, ec2.Port.tcp(5432), 'ECS to Database');
    // The stateful tier needs database access in its own right - it is the tier
    // that runs migrations (api/index.ts constructs ConfigStateful first so the
    // schema is current before the stateless side connects).
    this.database.addIngressRule(this.stateful, ec2.Port.tcp(5432), 'Stateful service to Database');
    this.database.addIngressRule(
      ec2.Peer.ipv6(vpcCidrIpv6),
      ec2.Port.tcp(5432),
      'Allow Internal IPv6 network access',
    );

    // ALB outbound - health checks and traffic to both task tiers
    this.alb.addEgressRule(this.ecs, ec2.Port.tcp(5000), 'Health checks to ECS');
    this.alb.addEgressRule(this.stateful, ec2.Port.tcp(5000), 'WebSocket traffic to stateful tasks');

    // Both task tiers run the same image and need the same egress: the stateful
    // tier is the one that actually holds the TAK Server connections, so its
    // egress set must match, not merely resemble, the stateless one.
    this.addTaskEgress(this.ecs, vpcCidrIpv4, vpcCidrIpv6);
    this.addTaskEgress(this.stateful, vpcCidrIpv4, vpcCidrIpv6);

    // Stateless tasks reach the hub over the internal ALB on port 80.
    this.ecs.addEgressRule(this.hubAlb, ec2.Port.tcp(80), 'Hub RPC to internal hub ALB');
    this.hubAlb.addEgressRule(this.stateful, ec2.Port.tcp(5002), 'Hub RPC to stateful tasks');

    // Create security group for media servers
    this.media = new ec2.SecurityGroup(this, 'MediaSecurityGroup', {
      vpc,
      securityGroupName: `TAK-${envConfig.stackName}-media-tasks`,
      description: 'Allow external access to Media Servers',
      allowAllOutbound: true
    });

    // Media server ports
    this.media.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8554), 'RTSP Protocol');
    this.media.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8889), 'WebRTC Protocol');
    this.media.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8890), 'SRT Protocol');
    this.media.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8888), 'HLS Protocol');
    this.media.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(1935), 'RTMP Protocol');

    cdk.Tags.of(this.media).add('Name', `TAK-${envConfig.stackName}-media-tasks`);
  }

  /**
   * Egress shared by every CloudTAK task tier: database, DNS, HTTP(S), VPC
   * endpoints, TAK Server (8089/8443/8446) and the media server protocol ports.
   *
   * Extracted so the stateless and stateful services cannot drift apart - they
   * run the same image and talk to the same dependencies.
   */
  private addTaskEgress(sg: ec2.SecurityGroup, vpcCidrIpv4: string, vpcCidrIpv6: string): void {
    sg.addEgressRule(this.database, ec2.Port.tcp(5432), 'ECS to Database');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP outbound IPv6');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS outbound IPv6');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'DNS');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.udp(53), 'DNS IPv6');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(53), 'DNS TCP');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(53), 'DNS TCP IPv6');
    // VPC endpoints for AWS services
    sg.addEgressRule(ec2.Peer.ipv4(vpcCidrIpv4), ec2.Port.tcp(443), 'VPC Endpoints');
    // TAK Server connections - IPv4
    sg.addEgressRule(ec2.Peer.ipv4(vpcCidrIpv4), ec2.Port.tcp(8089), 'TAK Streaming CoT');
    sg.addEgressRule(ec2.Peer.ipv4(vpcCidrIpv4), ec2.Port.tcp(8443), 'TAK Server API');
    sg.addEgressRule(ec2.Peer.ipv4(vpcCidrIpv4), ec2.Port.tcp(8446), 'TAK Server WebTAK');
    // TAK Server connections - IPv6
    sg.addEgressRule(ec2.Peer.ipv6(vpcCidrIpv6), ec2.Port.tcp(8089), 'TAK Streaming CoT IPv6');
    sg.addEgressRule(ec2.Peer.ipv6(vpcCidrIpv6), ec2.Port.tcp(8443), 'TAK Server API IPv6');
    sg.addEgressRule(ec2.Peer.ipv6(vpcCidrIpv6), ec2.Port.tcp(8446), 'TAK Server WebTAK IPv6');
    // Media server connections
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9997), 'Media server outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(9997), 'Media server outbound IPv6');
    // Additional media server protocol ports
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(1935), 'RTMP outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(1935), 'RTMP outbound IPv6');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8554), 'RTSP outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(8554), 'RTSP outbound IPv6');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(1936), 'RTMPS outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(1936), 'RTMPS outbound IPv6');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8555), 'RTSPS outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(8555), 'RTSPS outbound IPv6');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(8890), 'SRT outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.udp(8890), 'SRT outbound IPv6');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8888), 'HLS outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(8888), 'HLS outbound IPv6');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9996), 'Media server playback outbound');
    sg.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(9996), 'Media server playback outbound IPv6');
  }

}
