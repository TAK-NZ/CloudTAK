import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as kms from 'aws-cdk-lib/aws-kms';
import { ContextEnvironmentConfig } from '../stack-config';

export interface PMTilesEfsProps {
  envConfig: ContextEnvironmentConfig;
  vpc: ec2.IVpc;
  kmsKey: kms.IKey;
}

export class PMTilesEfs extends Construct {
  public readonly fileSystem: efs.FileSystem;
  public readonly accessPoint: efs.AccessPoint;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  public readonly cleanupLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: PMTilesEfsProps) {
    super(scope, id);

    const { envConfig, vpc, kmsKey } = props;

    // Security group for Lambda functions accessing EFS
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'PMTilesLambdaSG', {
      vpc,
      description: 'Security Group for PMTiles Lambda',
      allowAllOutbound: true
    });

    // Security group for EFS
    const efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSG', {
      vpc,
      description: 'Security Group for EFS',
      allowAllOutbound: false
    });

    efsSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(2049),
      'Allow NFS from Lambda'
    );

    // Create EFS file system
    this.fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc,
      encrypted: true,
      kmsKey,
      securityGroup: efsSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      fileSystemName: `TAK-${envConfig.stackName}-CloudTAK-pmtiles-efs`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      fileSystemPolicy: iam.PolicyDocument.fromJson({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: '*' },
          Action: [
            'elasticfilesystem:ClientMount',
            'elasticfilesystem:ClientWrite'
          ],
          Condition: {
            Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' }
          }
        }]
      })
    });

    // Create access point
    this.accessPoint = this.fileSystem.addAccessPoint('AccessPoint', {
      path: '/pmtiles',
      posixUser: {
        uid: '1000',
        gid: '1000'
      },
      createAcl: {
        ownerUid: '1000',
        ownerGid: '1000',
        permissions: '755'
      }
    });

    // Create cleanup Lambda role
    const cleanupRole = new iam.Role(this, 'CleanupLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
      ],
      inlinePolicies: {
        'efs-access': new iam.PolicyDocument({
          statements: [
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
      }
    });

    // Grant KMS permissions for EFS encryption
    kmsKey.grantDecrypt(cleanupRole);

    // Create cleanup Lambda
    this.cleanupLambda = new lambda.Function(this, 'CleanupLambda', {
      functionName: `TAK-${envConfig.stackName}-CloudTAK-efs-cleanup`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import fs from 'fs';
import path from 'path';

const MOUNT_PATH = '/mnt/efs';
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const handler = async () => {
    const now = Date.now();
    let deletedCount = 0;

    async function walk(dir) {
        let files;
        try {
            files = await fs.promises.readdir(dir);
        } catch (err) {
            console.error(\`Error reading directory \${dir}: \${err}\`);
            return;
        }

        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                const stats = await fs.promises.stat(filePath);
                if (stats.isDirectory()) {
                    await walk(filePath);
                } else {
                    if (now - stats.mtimeMs > RETENTION_MS) {
                        await fs.promises.unlink(filePath);
                        deletedCount++;
                        console.log(\`Deleted \${filePath}\`);
                    }
                }
            } catch (err) {
                console.error(\`Error processing \${filePath}: \${err}\`);
            }
        }
    }

    console.log('Starting cleanup...');

    if (fs.existsSync(MOUNT_PATH)) {
        await walk(MOUNT_PATH);
    } else {
        console.log(\`Mount path \${MOUNT_PATH} does not exist.\`);
    }

    console.log(\`Cleanup complete. Deleted \${deletedCount} files.\`);
    return { deleted: deletedCount };
};
`),
      role: cleanupRole,
      memorySize: 128,
      timeout: cdk.Duration.seconds(900),
      description: 'Cleanup old files from EFS',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.lambdaSecurityGroup],
      filesystem: lambda.FileSystem.fromEfsAccessPoint(this.accessPoint, '/mnt/efs')
    });

    // Schedule cleanup daily
    const rule = new events.Rule(this, 'CleanupSchedule', {
      description: 'Schedule for EFS Cleanup',
      schedule: events.Schedule.rate(cdk.Duration.days(1))
    });

    rule.addTarget(new targets.LambdaFunction(this.cleanupLambda));
  }
}
