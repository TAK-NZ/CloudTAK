/**
 * Retention Service construct
 *
 * Scheduled ECS Fargate task that runs daily to clean up expired data via the
 * CloudTAK retention API. Corresponds to cloudformation/lib/retention.js.
 *
 * Resources created:
 *   - CloudWatch log group
 *   - IAM task role  (s3:DeleteObject + Secrets Manager read)
 *   - IAM execution role
 *   - Fargate task definition  (256 CPU / 512 MB)
 *   - Security group           (no ingress)
 *   - EventBridge rule         (rate 1 day)
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as kms from 'aws-cdk-lib/aws-kms';
import { ContextEnvironmentConfig } from '../stack-config';

export interface RetentionServiceProps {
  envConfig: ContextEnvironmentConfig;
  vpc: ec2.IVpc;
  ecsCluster: ecs.ICluster;
  ecrRepository: ecr.IRepository;
  retentionImageAsset?: ecrAssets.DockerImageAsset;
  assetBucketName: string;
  serviceUrl: string;
  connectionStringSecret: secretsmanager.ISecret;
  signingSecret: secretsmanager.ISecret;
  kmsKey: kms.IKey;
}

export class RetentionService extends Construct {
  constructor(scope: Construct, id: string, props: RetentionServiceProps) {
    super(scope, id);

    const {
      envConfig,
      vpc,
      ecsCluster,
      ecrRepository,
      retentionImageAsset,
      assetBucketName,
      serviceUrl,
      connectionStringSecret,
      signingSecret,
      kmsKey,
    } = props;

    // CloudWatch log group
    const logGroup = new logs.LogGroup(this, 'RetentionLogs', {
      logGroupName: `TAK-${envConfig.stackName}-CloudTAK-retention`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: envConfig.general.removalPolicy === 'DESTROY'
        ? cdk.RemovalPolicy.DESTROY
        : cdk.RemovalPolicy.RETAIN,
    });

    // Task role — S3 delete + Secrets Manager read
    const taskRole = new iam.Role(this, 'RetentionTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        'retention-policy': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:DeleteObject'],
              resources: [
                `arn:${cdk.Stack.of(this).partition}:s3:::${assetBucketName}/*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'secretsmanager:Describe*',
                'secretsmanager:Get*',
                'secretsmanager:List*',
              ],
              resources: [
                `arn:${cdk.Stack.of(this).partition}:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:TAK-${envConfig.stackName}-*`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: [kmsKey.keyArn],
            }),
          ],
        }),
      },
    });

    // Execution role
    const executionRole = new iam.Role(this, 'RetentionExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
      inlinePolicies: {
        'retention-ecr': new iam.PolicyDocument({
          statements: [
            // ECR authorization token — must be resource: * (no ARN scoping possible)
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*'],
            }),
            // ECR image pull from the shared artifacts repository
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
              ],
              resources: [ecrRepository.repositoryArn],
            }),
          ],
        }),
      },
    });

    connectionStringSecret.grantRead(executionRole);
    signingSecret.grantRead(executionRole);

    // Task definition — 256 CPU / 512 MB (upstream fixed values)
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      'RetentionTaskDefinition',
      {
        family: `TAK-${envConfig.stackName}-CloudTAK-retention`,
        cpu: 256,
        memoryLimitMiB: 512,
        taskRole,
        executionRole,
      },
    );

    // Resolve container image
    let containerImage: ecs.ContainerImage;
    const usePreBuiltImages =
      cdk.Stack.of(this).node.tryGetContext('usePreBuiltImages') ?? false;
    const cloudtakImageTag = cdk.Stack.of(this).node.tryGetContext(
      'cloudtakImageTag',
    );

    if (usePreBuiltImages && cloudtakImageTag) {
      const retentionTag = `retention-${cloudtakImageTag.replace('cloudtak-', '')}`;
      const imageUri = `${cdk.Stack.of(this).account}.dkr.ecr.${cdk.Stack.of(this).region}.amazonaws.com/${cdk.Token.asString(ecrRepository.repositoryName)}:${retentionTag}`;
      containerImage = ecs.ContainerImage.fromRegistry(imageUri);
    } else if (retentionImageAsset) {
      containerImage = ecs.ContainerImage.fromDockerImageAsset(
        retentionImageAsset,
      );
    } else {
      throw new Error(
        'Either retentionImageAsset must be provided or usePreBuiltImages must be true with cloudtakImageTag',
      );
    }

    taskDefinition.addContainer('retention', {
      image: containerImage,
      command: ['npm', 'run', 'run-once'],
      environment: {
        AWS_REGION: cdk.Stack.of(this).region,
        StackName: `TAK-${envConfig.stackName}-CloudTAK`,
        ASSET_BUCKET: assetBucketName,
        API_URL: serviceUrl.startsWith('http')
          ? serviceUrl
          : `https://${serviceUrl}`,
      },
      secrets: {
        POSTGRES: ecs.Secret.fromSecretsManager(connectionStringSecret),
        SigningSecret: ecs.Secret.fromSecretsManager(signingSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: `TAK-${envConfig.stackName}-CloudTAK`,
      }),
    });

    // Security group — no ingress, full outbound for API calls
    const securityGroup = new ec2.SecurityGroup(
      this,
      'RetentionSecurityGroup',
      {
        vpc,
        description: 'Security group for CloudTAK retention task (no ingress)',
        allowAllOutbound: true,
      },
    );

    // EventBridge rule — run once per day
    const schedule = new events.Rule(this, 'RetentionSchedule', {
      description: 'Schedule for CloudTAK retention runs',
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      enabled: true,
    });

    schedule.addTarget(
      new targets.EcsTask({
        cluster: ecsCluster,
        taskDefinition,
        launchType: ecs.LaunchType.FARGATE,
        platformVersion: ecs.FargatePlatformVersion.LATEST,
        securityGroups: [securityGroup],
        subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
      }),
    );
  }
}
