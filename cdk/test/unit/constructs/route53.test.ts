import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Route53 } from '../../../lib/constructs/route53';
import { CDKTestHelper } from '../../__helpers__/cdk-test-utils';

describe('Route53 Construct', () => {
  function build() {
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    const { vpc } = CDKTestHelper.createMockInfrastructure(stack);
    const { hostedZone } = CDKTestHelper.createMockNetwork(stack);
    const alb = new elbv2.ApplicationLoadBalancer(stack, 'TestALB', {
      vpc,
      internetFacing: true
    });
    const route53 = new Route53(stack, 'TestRoute53', {
      hostedZone,
      hostname: 'map',
      loadBalancer: alb
    });
    return { stack, route53 };
  }

  // Decision logic worth pinning: serviceUrl is derived as `${hostname}.${zone}`.
  // A regression here changes every URL the app advertises.
  it('derives serviceUrl from hostname and zone', () => {
    const { route53 } = build();
    expect(route53.serviceUrl).toBe('map.test.com');
  });

  // Dual-stack smoke: both an A and an AAAA record are created. (The alias
  // target wiring is exercised by the full-stack synth in stack-synth.test.ts;
  // we intentionally do not re-assert the Fn::GetAtt/logical-id shape here,
  // which would only restate CDK's own token output.)
  it('creates both A and AAAA alias records', () => {
    const { stack } = build();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'A' });
    template.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'AAAA' });
  });
});
