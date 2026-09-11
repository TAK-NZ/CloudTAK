
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { LambdaFunctions } from '../../../lib/constructs/lambda-functions';
import { CDKTestHelper } from '../../__helpers__/cdk-test-utils';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

// The "creates an image-package Lambda" restatement was removed — the
// full-stack synth exercises the PMTiles Lambda. What remains is the PMTiles
// API Gateway name, which is a stable identifier the construct derives.
describe('LambdaFunctions Construct', () => {
  it('creates PMTiles API Gateway', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack2', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    const { kmsKey } = CDKTestHelper.createMockInfrastructure(stack);
    const { hostedZone } = CDKTestHelper.createMockNetwork(stack);
    const ecrRepository = CDKTestHelper.createMockEcrRepository(stack);
    const certificate = acm.Certificate.fromCertificateArn(
      stack, 'TestCert2',
      'arn:aws:acm:us-west-2:123456789012:certificate/test-cert'
    );
    const { signingSecret } = CDKTestHelper.createMockSecrets(stack);

    new LambdaFunctions(stack, 'TestLambdaFunctions', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      ecrRepository,
      kmsKey,
      hostedZone,
      certificate,
      serviceUrl: 'https://test.example.com',
      assetBucketName: 'test-bucket',
      signingSecret,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'TAK-DevTest-CloudTAK-pmtiles',
      ProtocolType: 'HTTP',
    });
  });
});
