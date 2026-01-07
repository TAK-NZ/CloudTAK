import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ContextEnvironmentConfig } from '../stack-config';

export interface LambdaFunctionsProps {
  envConfig: ContextEnvironmentConfig;
  ecrRepository: ecr.IRepository;
  tilesImageAsset?: ecrAssets.DockerImageAsset;
  assetBucketName: string;
  serviceUrl: string;
  signingSecret: secretsmanager.ISecret;
  kmsKey: cdk.aws_kms.IKey;
  hostedZone: cdk.aws_route53.IHostedZone;
  certificate: cdk.aws_certificatemanager.ICertificate;
  vpc: ec2.IVpc;
  efsAccessPoint: efs.IAccessPoint;
  lambdaSecurityGroup: ec2.ISecurityGroup;
}

export class LambdaFunctions extends Construct {
  public readonly tilesLambda: lambda.Function;
  public readonly tilesApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: LambdaFunctionsProps) {
    super(scope, id);

    const { envConfig, ecrRepository, tilesImageAsset, assetBucketName, serviceUrl, signingSecret, kmsKey, hostedZone, certificate, vpc, efsAccessPoint, lambdaSecurityGroup } = props;

    // Get image tag from context for CI/CD deployments
    const cloudtakImageTag = cdk.Stack.of(this).node.tryGetContext('cloudtakImageTag');

    
    // Create PMTiles Lambda Role
    const tilesLambdaRole = new iam.Role(this, 'PMTilesLambdaRole', {
      roleName: `TAK-${envConfig.stackName}-CloudTAK-pmtiles`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        'pmtiles': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:List*', 's3:Get*', 's3:Head*', 's3:Describe*'],
              resources: [`arn:${cdk.Stack.of(this).partition}:s3:::${assetBucketName}`, `arn:${cdk.Stack.of(this).partition}:s3:::${assetBucketName}/*`]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
              resources: [`arn:${cdk.Stack.of(this).partition}:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:TAK-${envConfig.stackName}-*`]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'elasticfilesystem:ClientMount',
                'elasticfilesystem:ClientWrite',
                'elasticfilesystem:DescribeMountTargets'
              ],
              resources: ['*']
            })
          ]
        })
      },
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
      ]
    });

    // Grant KMS permissions for S3, Secrets Manager, and EFS encryption
    kmsKey.grantDecrypt(tilesLambdaRole);
    
    // Create PMTiles Lambda
    const tilesTag = cloudtakImageTag ? `pmtiles-${cloudtakImageTag.replace('cloudtak-', '')}` : 'pmtiles-latest';
    const baseHostname = serviceUrl.replace('https://', '').replace('http://', '');
    const tilesHostname = `tiles.${baseHostname}`;
    
    this.tilesLambda = new lambda.Function(this, 'PMTilesLambda', {
      functionName: `TAK-${envConfig.stackName}-CloudTAK-pmtiles`,
      runtime: lambda.Runtime.FROM_IMAGE,
      code: tilesImageAsset 
        ? lambda.Code.fromEcrImage(tilesImageAsset.repository, {
            tagOrDigest: tilesImageAsset.assetHash
          })
        : lambda.Code.fromEcrImage(ecrRepository, {
            tagOrDigest: tilesTag
          }),
      handler: lambda.Handler.FROM_IMAGE,
      role: tilesLambdaRole,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      description: 'Return Mapbox Vector Tiles from a PMTiles Store',
      environment: {
        'StackName': cdk.Stack.of(this).stackName,
        'ASSET_BUCKET': assetBucketName,
        'PMTILES_URL': `https://${tilesHostname}`,
        'APIROOT': `https://${tilesHostname}`,  // Legacy value for PMTILES_URL
        'SigningSecret': `{{resolve:secretsmanager:${signingSecret.secretName}:SecretString::AWSCURRENT}}`
      },
      environmentEncryption: kmsKey,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSecurityGroup],
      filesystem: lambda.FileSystem.fromEfsAccessPoint(efsAccessPoint, '/mnt/efs')
    });
    
    // Note: No need to grant read access when using CloudFormation dynamic references
    
    // Create API Gateway for PMTiles
    // Force REGIONAL endpoint to use local certificate (EDGE requires us-east-1 certificate)
    const endpointType = apigateway.EndpointType.REGIONAL;
    
    this.tilesApi = new apigateway.RestApi(this, 'PMTilesAPI', {
      restApiName: `TAK-${envConfig.stackName}-CloudTAK-pmtiles`,
      description: 'PMTiles API Gateway',
      endpointConfiguration: {
        types: [endpointType]
      },
      binaryMediaTypes: ['application/vnd.mapbox-vector-tile', 'application/x-protobuf'],
      disableExecuteApiEndpoint: true,
      deploy: false,  // Disable default deployment to prevent prod stage
      // No default CORS - will add explicit OPTIONS method like CloudFormation
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: cdk.RemovalPolicy.DESTROY,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['*']
          })
        ]
      })
    });
    
    // Enable IPv6 support via CloudFormation property
    const cfnApi = this.tilesApi.node.defaultChild as apigateway.CfnRestApi;
    cfnApi.addPropertyOverride('EndpointConfiguration.IpAddressType', 'dualstack');
    
    // Create API Gateway execution role (like CloudFormation)
    const apiGatewayRole = new iam.Role(this, 'PMTilesApiGatewayRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      inlinePolicies: {
        'lambda-invoke': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['lambda:InvokeFunction'],
              resources: [this.tilesLambda.functionArn]
            })
          ]
        })
      }
    });
    
    // Add proxy resource for all paths
    const proxyResource = this.tilesApi.root.addResource('{proxy+}');
    proxyResource.addMethod('GET', new apigateway.LambdaIntegration(this.tilesLambda, {
      proxy: true,
      credentialsRole: apiGatewayRole
    }));
    
    // Add explicit OPTIONS method like CloudFormation
    proxyResource.addMethod('OPTIONS', new apigateway.MockIntegration({
      integrationResponses: [{
        statusCode: '204',
        responseParameters: {
          'method.response.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
          'method.response.header.Access-Control-Allow-Origin': "'*'",
          'method.response.header.Access-Control-Allow-Methods': "'OPTIONS,GET,PUT,POST,DELETE,PATCH,HEAD'"
        }
      }],
      requestTemplates: {
        'application/json': '{ "statusCode": 200 }'
      }
    }), {
      methodResponses: [{
        statusCode: '204',
        responseParameters: {
          'method.response.header.Access-Control-Allow-Headers': true,
          'method.response.header.Access-Control-Allow-Origin': true,
          'method.response.header.Access-Control-Allow-Methods': true
        }
      }]
    });
    
    // No Lambda permissions needed - using API Gateway execution role
    
    // Create custom domain and base path mapping (matches CloudFormation approach)
    const domainName = new apigateway.DomainName(this, 'PMTilesDomain', {
      domainName: tilesHostname,
      certificate: certificate,
      endpointType: endpointType,
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2
    });
    
    // Create deployment and stage like CloudFormation
    const deployment = new apigateway.Deployment(this, 'PMTilesDeployment', {
      api: this.tilesApi,
      description: envConfig.stackName
    });
    
    deployment.node.addDependency(proxyResource);
    
    const stage = new apigateway.Stage(this, 'PMTilesStage', {
      deployment: deployment,
      stageName: 'tiles'
    });
    
    // Create base path mapping to tiles stage
    new apigateway.BasePathMapping(this, 'PMTilesBasePathMapping', {
      domainName: domainName,
      restApi: this.tilesApi,
      stage: stage
    });
    
    // Create Route53 records for tiles subdomain (using custom domain)
    new route53.ARecord(this, 'PMTilesDNS', {
      zone: hostedZone,
      recordName: `tiles.${envConfig.cloudtak.hostname}`,
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(domainName)
      ),
      comment: `${cdk.Stack.of(this).stackName} PMTiles API DNS Entry`
    });
    
    // Add IPv6 support with AAAA record
    new route53.AaaaRecord(this, 'PMTilesDNSIPv6', {
      zone: hostedZone,
      recordName: `tiles.${envConfig.cloudtak.hostname}`,
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayDomain(domainName)
      ),
      comment: `${cdk.Stack.of(this).stackName} PMTiles API IPv6 DNS Entry`
    });
  }
}