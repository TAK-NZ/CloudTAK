/**
 * Webhooks Infrastructure Construct
 * 
 * Provides incoming webhook support for CloudTAK layers via API Gateway V2.
 * Each layer can register webhook routes dynamically through the API.
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ContextEnvironmentConfig } from '../stack-config';

export interface WebhooksProps {
  envConfig: ContextEnvironmentConfig;
  hostedZone: route53.IHostedZone;
  certificate: acm.ICertificate;
  subdomainPrefix?: string;
}

export class Webhooks extends Construct {
  public readonly api: apigatewayv2.CfnApi;
  public readonly apiGatewayRole: iam.Role;
  public readonly domainName: apigatewayv2.CfnDomainName;
  public readonly webhookUrl: string;

  constructor(scope: Construct, id: string, props: WebhooksProps) {
    super(scope, id);

    const { envConfig, hostedZone, certificate, subdomainPrefix = 'webhooks' } = props;
    const stackName = cdk.Stack.of(this).stackName;

    // Construct webhook domain name
    this.webhookUrl = `${subdomainPrefix}.${hostedZone.zoneName}`;

    // Create API Gateway V2 HTTP API
    this.api = new apigatewayv2.CfnApi(this, 'WebhooksAPI', {
      name: `${stackName}-webhooks`,
      protocolType: 'HTTP',
      disableExecuteApiEndpoint: true,
      description: 'Incoming Webhook support for CloudTAK'
    });

    // Create custom domain for API Gateway
    this.domainName = new apigatewayv2.CfnDomainName(this, 'WebhooksDomain', {
      domainName: this.webhookUrl,
      domainNameConfigurations: [{
        certificateArn: certificate.certificateArn,
        endpointType: 'REGIONAL'
      }]
    });

    // Create IAM role for API Gateway to invoke Lambda functions
    this.apiGatewayRole = new iam.Role(this, 'WebhooksAPIGatewayRole', {
      roleName: `${stackName}-webhooks-apigw`,
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      description: 'Allows API Gateway to invoke CloudTAK layer Lambda functions'
    });

    // Grant permission to invoke layer Lambda functions
    this.apiGatewayRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:${cdk.Stack.of(this).partition}:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:${stackName}-layer-*`
      ]
    }));

    // Create health check Lambda function
    const healthCheckFunction = new lambda.Function(this, 'HealthCheckFunction', {
      functionName: `${stackName}-webhooks-health`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`def handler(event, context):
    return {
        'statusCode': 200,
        'body': 'CloudTAK Webhooks API - Healthy'
    }`),
      description: 'Health check endpoint for CloudTAK webhooks API'
    });

    // Grant API Gateway permission to invoke health check function
    this.apiGatewayRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [healthCheckFunction.functionArn]
    }));

    // Create integration for health check
    const healthCheckIntegration = new apigatewayv2.CfnIntegration(this, 'HealthCheckIntegration', {
      apiId: this.api.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: healthCheckFunction.functionArn,
      credentialsArn: this.apiGatewayRole.roleArn,
      payloadFormatVersion: '2.0'
    });

    // Create health check route
    const healthCheckRoute = new apigatewayv2.CfnRoute(this, 'HealthCheckRoute', {
      apiId: this.api.ref,
      routeKey: 'GET /health',
      target: `integrations/${healthCheckIntegration.ref}`
    });

    // Create deployment (depends on routes)
    const deployment = new apigatewayv2.CfnDeployment(this, 'WebhooksDeployment', {
      apiId: this.api.ref,
      description: `${stackName} webhooks deployment`
    });
    deployment.addDependency(healthCheckRoute);

    // Create default stage
    const stage = new apigatewayv2.CfnStage(this, 'WebhooksStage', {
      apiId: this.api.ref,
      stageName: '$default',
      deploymentId: deployment.ref,
      autoDeploy: true
    });

    // Map custom domain to API
    const apiMapping = new apigatewayv2.CfnApiMapping(this, 'WebhooksAPIMapping', {
      apiId: this.api.ref,
      domainName: this.domainName.ref,
      stage: stage.ref
    });

    // Create Route53 A record for webhook domain
    new route53.ARecord(this, 'WebhooksARecord', {
      zone: hostedZone,
      recordName: subdomainPrefix,
      target: route53.RecordTarget.fromAlias({
        bind: () => ({
          dnsName: this.domainName.attrRegionalDomainName,
          hostedZoneId: this.domainName.attrRegionalHostedZoneId
        })
      })
    });

    // CloudFormation outputs for layer integration
    new cdk.CfnOutput(this, 'WebhooksURL', {
      value: `https://${this.webhookUrl}`,
      description: 'Webhooks API Base URL',
      exportName: `${stackName}-webhooks`
    });

    new cdk.CfnOutput(this, 'WebhooksRoleArn', {
      value: this.apiGatewayRole.roleArn,
      description: 'API Gateway invocation role ARN',
      exportName: `${stackName}-webhooks-role`
    });

    new cdk.CfnOutput(this, 'WebhooksAPIId', {
      value: this.api.ref,
      description: 'API Gateway ID for layer webhook registration',
      exportName: `${stackName}-webhooks-api`
    });
  }
}
