import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { LambdaFunctions } from '../../../lib/constructs/lambda-functions';
import { CDKTestHelper } from '../../__helpers__/cdk-test-utils';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

describe('LambdaFunctions Construct', () => {
  it('creates event Lambda function', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack1', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    const { kmsKey } = CDKTestHelper.createMockInfrastructure(stack);
    const { hostedZone } = CDKTestHelper.createMockNetwork(stack);
    const ecrRepository = CDKTestHelper.createMockEcrRepository(stack);
    const certificate = acm.Certificate.fromCertificateArn(
      stack, 'TestCert1',
      'arn:aws:acm:us-west-2:123456789012:certificate/test-cert'
    );
    const { signingSecret } = CDKTestHelper.createMockSecrets(stack);
    
    // Mock VPC, EFS, and Security Group
    const vpc = ec2.Vpc.fromVpcAttributes(stack, 'TestVpc1', {
      vpcId: 'vpc-12345',
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      privateSubnetIds: ['subnet-1', 'subnet-2']
    });
    const fileSystem = efs.FileSystem.fromFileSystemAttributes(stack, 'TestEfs1', {
      fileSystemId: 'fs-12345',
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(stack, 'TestEfsSg1', 'sg-efs-12345')
    });
    const efsAccessPoint = efs.AccessPoint.fromAccessPointAttributes(stack, 'TestEfsAp1', {
      accessPointId: 'fsap-12345',
      fileSystem
    });
    const lambdaSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(stack, 'TestSg1', 'sg-12345');

    const lambdaFunctions = new LambdaFunctions(stack, 'TestLambdaFunctions', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      ecrRepository,
      kmsKey,
      hostedZone,
      certificate,
      serviceUrl: 'https://test.example.com',
      assetBucketName: 'test-bucket',
      signingSecret,
      vpc,
      efsAccessPoint,
      lambdaSecurityGroup
    });

    expect(lambdaFunctions.tilesLambda).toBeDefined();
    expect(lambdaFunctions.tilesApi).toBeDefined();

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image'
    });
  });

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
    
    // Mock VPC, EFS, and Security Group
    const vpc = ec2.Vpc.fromVpcAttributes(stack, 'TestVpc2', {
      vpcId: 'vpc-12345',
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      privateSubnetIds: ['subnet-1', 'subnet-2']
    });
    const fileSystem = efs.FileSystem.fromFileSystemAttributes(stack, 'TestEfs2', {
      fileSystemId: 'fs-12345',
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(stack, 'TestEfsSg2', 'sg-efs-12345')
    });
    const efsAccessPoint = efs.AccessPoint.fromAccessPointAttributes(stack, 'TestEfsAp2', {
      accessPointId: 'fsap-12345',
      fileSystem
    });
    const lambdaSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(stack, 'TestSg2', 'sg-12345');

    new LambdaFunctions(stack, 'TestLambdaFunctions', {
      envConfig: MOCK_CONFIGS.DEV_TEST,
      ecrRepository,
      kmsKey,
      hostedZone,
      certificate,
      serviceUrl: 'https://test.example.com',
      assetBucketName: 'test-bucket',
      signingSecret,
      vpc,
      efsAccessPoint,
      lambdaSecurityGroup
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'TAK-DevTest-CloudTAK-pmtiles'
    });
  });
});