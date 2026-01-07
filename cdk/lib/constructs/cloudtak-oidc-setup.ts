import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export interface CloudTakOidcSetupProps {
  stackName: string;
  authentikUrl: string;
  authentikAdminSecretArn: string;
  cloudtakUrl: string;
  kmsKeyArn: string;
  vpc?: cdk.aws_ec2.IVpc;
  securityGroup?: cdk.aws_ec2.ISecurityGroup;
}

export class CloudTakOidcSetup extends Construct {
  public readonly clientId: string;
  public readonly clientSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: CloudTakOidcSetupProps) {
    super(scope, id);

    // Create Lambda function for OIDC setup
    const oidcSetupFunction = new lambda.Function(this, 'OidcSetupFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src/cloudtak-oidc-setup')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      vpc: props.vpc,
      securityGroups: props.securityGroup ? [props.securityGroup] : undefined,
      vpcSubnets: props.vpc ? { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS } : undefined,
      environment: {
        AUTHENTIK_URL: props.authentikUrl,
        AUTHENTIK_ADMIN_SECRET_ARN: props.authentikAdminSecretArn,
        PROVIDER_NAME: 'CloudTAK OAuth Provider',
        APPLICATION_NAME: 'CloudTAK',
        APPLICATION_SLUG: 'cloudtak',
        REDIRECT_URIS: JSON.stringify([`${props.cloudtakUrl}/oauth2/idpresponse`]),
        LAUNCH_URL: `${props.cloudtakUrl}/api/login/oidc`,
        GROUP_NAME: 'Team Awareness Kit',
      },
    });

    // Grant Lambda permission to read Authentik admin secret
    const authentikAdminSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'AuthentikAdminSecret',
      props.authentikAdminSecretArn
    );
    authentikAdminSecret.grantRead(oidcSetupFunction);

    // Grant Lambda permission to use KMS key
    oidcSetupFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['kms:Decrypt'],
      resources: [props.kmsKeyArn],
    }));

    // Create custom resource provider
    const provider = new cr.Provider(this, 'OidcSetupProvider', {
      onEventHandler: oidcSetupFunction,
    });

    // Create custom resource
    const oidcSetup = new cdk.CustomResource(this, 'OidcSetup', {
      serviceToken: provider.serviceToken,
      properties: {
        // Trigger update when these change
        AuthentikUrl: props.authentikUrl,
        CloudTakUrl: props.cloudtakUrl,
        Timestamp: Date.now(), // Force update on each deployment
      },
    });

    // Get client ID from custom resource
    this.clientId = oidcSetup.getAttString('clientId');

    // Store client secret in Secrets Manager
    this.clientSecret = new secretsmanager.Secret(this, 'ClientSecret', {
      secretName: `TAK-${props.stackName}-CloudTAK-AuthentikClientSecret`,
      description: 'Authentik OIDC client secret for CloudTAK ALB',
      secretStringValue: cdk.SecretValue.resourceAttribute(
        oidcSetup.getAttString('clientSecret')
      ),
      encryptionKey: cdk.aws_kms.Key.fromKeyArn(this, 'KmsKey', props.kmsKeyArn),
    });
  }
}
