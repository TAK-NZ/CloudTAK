import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { ContextEnvironmentConfig } from '../stack-config';

export interface EventsServiceProps {
  environment: 'prod' | 'dev-test';
  envConfig: ContextEnvironmentConfig;
  vpc: ec2.IVpc;
  ecsCluster: ecs.ICluster;
  ecrRepository: ecr.IRepository;
  eventsImageAsset?: ecrAssets.DockerImageAsset;
  assetBucketName: string;
  serviceUrl: string;
  signingSecret: secretsmanager.ISecret;
  kmsKey: cdk.aws_kms.IKey;
}

export class EventsService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EventsServiceProps) {
    super(scope, id);

    const { environment, envConfig, vpc, ecsCluster, ecrRepository, eventsImageAsset, assetBucketName, serviceUrl, signingSecret, kmsKey } = props;

    // Create CloudWatch log group
    const logGroup = new logs.LogGroup(this, 'EventsLogs', {
      logGroupName: `TAK-${envConfig.stackName}-CloudTAK-events`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: envConfig.general.removalPolicy === 'DESTROY' ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN
    });

    // Create task role with necessary permissions
    const taskRole = new iam.Role(this, 'EventsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        'events-policy': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ssmmessages:CreateControlChannel',
                'ssmmessages:CreateDataChannel', 
                'ssmmessages:OpenControlChannel',
                'ssmmessages:OpenDataChannel'
              ],
              resources: ['*']
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: [kmsKey.keyArn]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:*'],
              resources: [
                `arn:${cdk.Stack.of(this).partition}:s3:::${assetBucketName}`,
                `arn:${cdk.Stack.of(this).partition}:s3:::${assetBucketName}/*`
              ]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'secretsmanager:Describe*',
                'secretsmanager:Get*',
                'secretsmanager:List*'
              ],
              resources: [
                `arn:${cdk.Stack.of(this).partition}:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:TAK-${envConfig.stackName}-*`
              ]
            })
          ]
        })
      }
    });

    // Create execution role
    const executionRole = new iam.Role(this, 'EventsExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ],
      inlinePolicies: {
        'events-logging': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogStreams'
              ],
              resources: [`arn:${cdk.Stack.of(this).partition}:logs:*:*:*`]
            })
          ]
        })
      }
    });

    // Create task definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'EventsTaskDefinition', {
      family: `TAK-${envConfig.stackName}-CloudTAK-events`,
      cpu: envConfig.ecs.taskCpu,
      memoryLimitMiB: envConfig.ecs.taskMemory,
      taskRole: taskRole,
      executionRole: executionRole
    });

    // Determine container image
    let containerImage: ecs.ContainerImage;
    const usePreBuiltImages = cdk.Stack.of(this).node.tryGetContext('usePreBuiltImages') ?? false;
    const cloudtakImageTag = cdk.Stack.of(this).node.tryGetContext('cloudtakImageTag');

    if (usePreBuiltImages && cloudtakImageTag) {
      const eventsTag = `events-${cloudtakImageTag.replace('cloudtak-', '')}`;
      const imageUri = `${cdk.Stack.of(this).account}.dkr.ecr.${cdk.Stack.of(this).region}.amazonaws.com/${cdk.Token.asString(ecrRepository.repositoryName)}:${eventsTag}`;
      containerImage = ecs.ContainerImage.fromRegistry(imageUri);
    } else if (eventsImageAsset) {
      containerImage = ecs.ContainerImage.fromDockerImageAsset(eventsImageAsset);
    } else {
      throw new Error('Either eventsImageAsset must be provided or usePreBuiltImages must be true with cloudtakImageTag');
    }

    // Add container to task definition
    const container = this.taskDefinition.addContainer('events', {
      image: containerImage,
      essential: true,
      environment: {
        'SigningSecret': `{{resolve:secretsmanager:${signingSecret.secretName}:SecretString::AWSCURRENT}}`,
        'AWS_REGION': cdk.Stack.of(this).region,
        'StackName': cdk.Stack.of(this).stackName,
        'ASSET_BUCKET': assetBucketName,
        'API_URL': serviceUrl.startsWith('http') ? serviceUrl : `https://${serviceUrl}`
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroup,
        streamPrefix: `TAK-${envConfig.stackName}-CloudTAK`
      })
    });

    container.addPortMappings({
      containerPort: 5000,
      protocol: ecs.Protocol.TCP
    });

    // Create security group
    this.securityGroup = new ec2.SecurityGroup(this, 'EventsSecurityGroup', {
      vpc: vpc,
      description: 'Security group for Events ECS service',
      allowAllOutbound: true
    });

    // Create ECS service
    this.service = new ecs.FargateService(this, 'EventsService', {
      serviceName: `TAK-${envConfig.stackName}-CloudTAK-events`,
      cluster: ecsCluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [this.securityGroup],
      enableExecuteCommand: envConfig.ecs.enableEcsExec,

      healthCheckGracePeriod: cdk.Duration.seconds(300),
      propagateTags: ecs.PropagatedTagSource.SERVICE
    });

    // Add tags
    cdk.Tags.of(this.service).add('Name', `TAK-${envConfig.stackName}-CloudTAK-events`);
  }
}