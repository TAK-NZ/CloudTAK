import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Secrets } from '../../../lib/constructs/secrets';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

describe('Secrets Construct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    
    const kmsKey = new kms.Key(stack, 'TestKey');
    const envConfig = MOCK_CONFIGS.DEV_TEST;
    
    new Secrets(stack, 'TestSecrets', {
      envConfig,
      kmsKey
    });
    
    template = Template.fromStack(stack);
  });

  test('creates all required secrets for CloudTAK API', () => {
    // Verify signing secret exists
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'TAK-DevTest-CloudTAK/api/secret',
      Description: 'TAK-DevTest-CloudTAK Signing Secret'
    });

    // Verify media secret exists
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'TAK-DevTest-CloudTAK/api/media',
      Description: 'TAK-DevTest-CloudTAK Media Secret'
    });

    // Verify geofence secret exists
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'TAK-DevTest-CloudTAK/api/geofence',
      Description: 'TAK-DevTest-CloudTAK Geofence Secret'
    });

    // Verify admin password secret exists
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'TAK-DevTest-CloudTAK/API/Admin-Password',
      Description: 'CloudTAK Admin Username and Password'
    });
  });

  test('creates exactly 4 secrets', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 4);
  });

  test('all secrets use KMS encryption', () => {
    // Every secret must be KMS-encrypted. Match on the shape rather than the
    // KMS key's generated logical id, which is CDK-internal and would make this
    // fail on an unrelated rename.
    template.allResourcesProperties('AWS::SecretsManager::Secret', {
      KmsKeyId: Match.objectLike({ 'Fn::GetAtt': [Match.anyValue(), 'Arn'] })
    });
  });

  test('admin password secret has correct template structure', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: {
        SecretStringTemplate: '{"username":"ckadmin"}',
        GenerateStringKey: 'password',
        ExcludePunctuation: true,
        PasswordLength: 32
      }
    });
  });
});