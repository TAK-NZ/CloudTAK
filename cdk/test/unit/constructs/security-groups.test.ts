import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SecurityGroups } from '../../../lib/constructs/security-groups';
import { CDKTestHelper } from '../../__helpers__/cdk-test-utils';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

describe('SecurityGroups Construct', () => {
  // Security-property test worth keeping: the exact set of media ports exposed
  // to 0.0.0.0/0. Accidentally opening or closing one of these is a real,
  // security-relevant defect — not a restatement of incidental construct code.
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