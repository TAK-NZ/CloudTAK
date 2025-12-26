import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { ContextEnvironmentConfig } from '../stack-config';

export interface EtlRoleProps {
  envConfig: ContextEnvironmentConfig;
  assetBucketName: string;
  kmsKey: kms.IKey;
}

export class EtlRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: EtlRoleProps) {
    super(scope, id);

    const { envConfig, assetBucketName, kmsKey } = props;

    this.role = new iam.Role(this, 'ETLFunctionRole', {
      roleName: `TAK-${envConfig.stackName}-CloudTAK-etl`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for CloudTAK ETL Lambda functions',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaSQSQueueExecutionRole')
      ],
      inlinePolicies: {
        'etl-policy': new iam.PolicyDocument({
          statements: [
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
              actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
              resources: ['*']
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'secretsmanager:Describe*',
                'secretsmanager:Get*',
                'secretsmanager:List*'
              ],
              resources: [
                `arn:${cdk.Stack.of(this).partition}:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:TAK-${envConfig.stackName}-CloudTAK/*`
              ]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'sqs:SendMessage',
                'sqs:ChangeMessageVisibility',
                'sqs:DeleteMessage',
                'sqs:GetQueueUrl',
                'sqs:GetQueueAttributes',
                'sqs:ReceiveMessage'
              ],
              resources: [
                `arn:${cdk.Stack.of(this).partition}:sqs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:TAK-${envConfig.stackName}-CloudTAK-layer-*`
              ]
            })
          ]
        })
      }
    });
  }
}
