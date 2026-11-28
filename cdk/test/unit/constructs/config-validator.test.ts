import { ConfigValidator } from '../../../lib/utils/config-validator';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

// Decision-logic tests: ConfigValidator encodes required-field rules. Each
// case names the bug it catches — a required field silently dropped from the
// validator would let a broken config synth.
describe('ConfigValidator', () => {
  it('accepts a valid configuration', () => {
    expect(() => {
      ConfigValidator.validateEnvironmentConfig(MOCK_CONFIGS.DEV_TEST, 'dev-test');
    }).not.toThrow();
  });

  it('throws when stackName is missing', () => {
    const invalidConfig = { ...MOCK_CONFIGS.DEV_TEST };
    delete (invalidConfig as any).stackName;

    expect(() => {
      ConfigValidator.validateEnvironmentConfig(invalidConfig, 'dev-test');
    }).toThrow('stackName is required');
  });

  it('throws when database config is missing', () => {
    const invalidConfig = { ...MOCK_CONFIGS.DEV_TEST };
    delete (invalidConfig as any).database;

    expect(() => {
      ConfigValidator.validateEnvironmentConfig(invalidConfig, 'dev-test');
    }).toThrow('database configuration is required');
  });

  it('throws when ecs config is missing', () => {
    const invalidConfig = { ...MOCK_CONFIGS.DEV_TEST };
    delete (invalidConfig as any).ecs;

    expect(() => {
      ConfigValidator.validateEnvironmentConfig(invalidConfig, 'dev-test');
    }).toThrow('ecs configuration is required');
  });

  it('throws when cloudtak config is missing', () => {
    const invalidConfig = { ...MOCK_CONFIGS.DEV_TEST };
    delete (invalidConfig as any).cloudtak;

    expect(() => {
      ConfigValidator.validateEnvironmentConfig(invalidConfig, 'dev-test');
    }).toThrow('cloudtak.hostname is required in environment configuration');
  });

  describe('cloudtak.breakGlass', () => {
    const withBreakGlass = (breakGlass: any) => ({ ...MOCK_CONFIGS.DEV_TEST, cloudtak: { ...MOCK_CONFIGS.DEV_TEST.cloudtak, breakGlass } });
    const validate = (breakGlass: any) => ConfigValidator.validateEnvironmentConfig(withBreakGlass(breakGlass), 'prod');

    it('accepts an empty block, and a full one', () => {
      expect(() => validate({})).not.toThrow();
      expect(() => validate({
        sealed: true,
        alertEmails: ['ops@example.test'],
        roleTrustedPrincipals: ['arn:aws:iam::123456789012:role/Ops', 'arn:aws:iam::123456789012:user/chris', 'arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/ap-southeast-2/AWSReservedSSO_Admin_abc'],
        roleRequireMfa: true
      })).not.toThrow();
    });

    it('rejects an alert address that is not an email address, so a typo cannot silence the alarm', () => {
      expect(() => validate({ alertEmails: ['ops@example.test', 'not-an-address'] })).toThrow(/not-an-address.*not an email address/);
    });

    it('rejects a trusted principal that is not an IAM role or user ARN (an account root or a service would widen the trust)', () => {
      for (const arn of ['arn:aws:iam::123456789012:root', 'ops', 'arn:aws:s3:::bucket', 'arn:aws:iam::123:role/Ops', 'lambda.amazonaws.com']) {
        expect(() => validate({ roleTrustedPrincipals: [arn] })).toThrow(/not an IAM role or user ARN/);
      }
    });

    it('accepts an Identity Center permission-set pattern, with or without a Region segment', () => {
      expect(() => validate({ roleTrustedPrincipalPatterns: ['arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/ap-southeast-2/AWSReservedSSO_PlatformAdmin_*'] })).not.toThrow();
      expect(() => validate({ roleTrustedPrincipalPatterns: ['arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_PlatformAdmin_*'] })).not.toThrow();
    });

    it('rejects a pattern that is too broad, so a wildcard cannot trust every role', () => {
      for (const pattern of [
        '*',
        'arn:aws:iam::123456789012:role/*',
        'arn:aws:iam::123456789012:role/a*',
        'arn:aws:iam::123456789012:role/aws-reserved/*',
        'arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/ap-southeast-2/AWSReservedSSO_PlatformAdmin_*',
        'arn:aws:iam::123456789012:user/chris*',
        'AWSReservedSSO_PlatformAdmin_*'
      ]) {
        expect(() => validate({ roleTrustedPrincipalPatterns: [pattern] })).toThrow(/roleTrustedPrincipalPatterns/);
      }
    });

    it('lets MFA be switched off with a pattern as the named principal', () => {
      expect(() => validate({ roleRequireMfa: false, roleTrustedPrincipalPatterns: ['arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/ap-southeast-2/AWSReservedSSO_PlatformAdmin_*'] })).not.toThrow();
    });

    it('does not let MFA be switched off while the role trusts the whole account', () => {
      expect(() => validate({ roleRequireMfa: false })).toThrow(/needs roleTrustedPrincipals/);
      expect(() => validate({ roleRequireMfa: false, roleTrustedPrincipals: [] })).toThrow(/needs roleTrustedPrincipals/);
      expect(() => validate({ roleRequireMfa: false, roleTrustedPrincipals: ['arn:aws:iam::123456789012:role/Ops'] })).not.toThrow();
    });
  });
});