import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SecurityGroups } from '../../../lib/constructs/security-groups';
import { CDKTestHelper } from '../../__helpers__/cdk-test-utils';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

describe('SecurityGroups Construct', () => {
  it('creates security groups without errors', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const vpc = CDKTestHelper.createMockVpc(stack);

    expect(() => {
      new SecurityGroups(stack, 'TestSecurityGroups', {
        vpc,
        envConfig: MOCK_CONFIGS.DEV_TEST
      });
    }).not.toThrow();
  });

  it('creates ALB security group', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const vpc = CDKTestHelper.createMockVpc(stack);

    new SecurityGroups(stack, 'TestSecurityGroups', {
      vpc,
      envConfig: MOCK_CONFIGS.DEV_TEST
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'TAK-DevTest-CloudTAK ALB Security Group'
    });
  });

  it('creates media security group with required ports', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const vpc = CDKTestHelper.createMockVpc(stack);

    new SecurityGroups(stack, 'TestSecurityGroups', {
      vpc,
      envConfig: MOCK_CONFIGS.DEV_TEST
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Allow external access to Media Servers',
      SecurityGroupIngress: [
        { IpProtocol: 'tcp', FromPort: 8554, ToPort: 8554, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'tcp', FromPort: 8889, ToPort: 8889, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'tcp', FromPort: 8890, ToPort: 8890, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'tcp', FromPort: 8888, ToPort: 8888, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'tcp', FromPort: 1935, ToPort: 1935, CidrIp: '0.0.0.0/0' }
      ]
    });
  });
});