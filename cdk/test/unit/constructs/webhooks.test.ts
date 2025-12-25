import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Webhooks } from '../../../lib/constructs/webhooks';
import { ContextEnvironmentConfig } from '../../../lib/stack-config';

describe('Webhooks Construct', () => {
  let stack: cdk.Stack;
  let envConfig: ContextEnvironmentConfig;
  let hostedZone: route53.IHostedZone;
  let certificate: acm.ICertificate;

  beforeEach(() => {
    const app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    
    envConfig = {
      stackName: 'Test',
      database: {
        instanceClass: 'db.serverless',
        instanceCount: 1,
        allocatedStorage: 20,
        maxAllocatedStorage: 100,
        enablePerformanceInsights: false,
        monitoringInterval: 0,
        backupRetentionDays: 7,
        deleteProtection: false
      },
      ecs: {
        taskCpu: 1024,
        taskMemory: 4096,
        desiredCount: 1,
        enableDetailedLogging: false
      },
      cloudtak: {
        hostname: 'map',
        takAdminEmail: 'admin@test.com',
        useS3CloudTAKConfigFile: false
      },
      ecr: {
        imageRetentionCount: 5,
        scanOnPush: false
      },
      general: {
        removalPolicy: 'DESTROY',
        enableDetailedLogging: false,
        enableContainerInsights: false
      },
      s3: {
        enableVersioning: false
      },
      mediainfra: {
        mediaHostname: 'media'
      }
    };

    hostedZone = route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
      hostedZoneId: 'Z1234567890ABC',
      zoneName: 'test.tak.nz'
    });

    certificate = acm.Certificate.fromCertificateArn(
      stack,
      'Cert',
      'arn:aws:acm:ap-southeast-2:123456789012:certificate/12345678-1234-1234-1234-123456789012'
    );
  });

  test('creates API Gateway V2 HTTP API', () => {
    new Webhooks(stack, 'Webhooks', {
      envConfig,
      hostedZone,
      certificate
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      DisableExecuteApiEndpoint: true
    });
  });

  test('creates custom domain with certificate', () => {
    new Webhooks(stack, 'Webhooks', {
      envConfig,
      hostedZone,
      certificate
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'webhooks.test.tak.nz',
      DomainNameConfigurations: [{
        CertificateArn: 'arn:aws:acm:ap-southeast-2:123456789012:certificate/12345678-1234-1234-1234-123456789012',
        EndpointType: 'REGIONAL'
      }]
    });
  });

  test('creates IAM role for API Gateway', () => {
    new Webhooks(stack, 'Webhooks', {
      envConfig,
      hostedZone,
      certificate
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'apigateway.amazonaws.com' },
          Action: 'sts:AssumeRole'
        }]
      }
    });
  });

  test('creates health check Lambda function', () => {
    new Webhooks(stack, 'Webhooks', {
      envConfig,
      hostedZone,
      certificate
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'index.handler'
    });
  });

  test('creates Route53 A record', () => {
    new Webhooks(stack, 'Webhooks', {
      envConfig,
      hostedZone,
      certificate
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'webhooks.test.tak.nz.'
    });
  });

  test('creates CloudFormation outputs', () => {
    new Webhooks(stack, 'Webhooks', {
      envConfig,
      hostedZone,
      certificate
    });

    const template = Template.fromStack(stack);
    const outputs = template.toJSON().Outputs;
    const outputKeys = Object.keys(outputs);
    expect(outputKeys.some(k => k.includes('WebhooksURL'))).toBe(true);
    expect(outputKeys.some(k => k.includes('WebhooksRoleArn'))).toBe(true);
    expect(outputKeys.some(k => k.includes('WebhooksAPIId'))).toBe(true);
  });

  test('uses custom subdomain when provided', () => {
    new Webhooks(stack, 'Webhooks', {
      envConfig,
      hostedZone,
      certificate,
      subdomainPrefix: 'hooks'
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'hooks.test.tak.nz'
    });
  });

  test('grants Lambda invoke permission to API Gateway role', () => {
    new Webhooks(stack, 'Webhooks', {
      envConfig,
      hostedZone,
      certificate
    });

    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources;
    const policies = Object.values(resources).filter((r: any) => r.Type === 'AWS::IAM::Policy');
    const hasLambdaInvoke = policies.some((policy: any) => 
      policy.Properties.PolicyDocument.Statement.some((stmt: any) => 
        stmt.Action.includes('lambda:InvokeFunction')
      )
    );
    expect(hasLambdaInvoke).toBe(true);
  });
});
