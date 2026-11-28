import { ContextEnvironmentConfig } from '../stack-config';
import { parseWebPlugins } from './web-plugins';

export class ConfigValidator {
  static validateEnvironmentConfig(envConfig: ContextEnvironmentConfig, environment: 'prod' | 'dev-test'): void {
    if (!envConfig.stackName) {
      throw new Error('stackName is required in environment configuration');
    }
    
    if (!envConfig.cloudtak?.hostname) {
      throw new Error('cloudtak.hostname is required in environment configuration');
    }
    
    if (!envConfig.database) {
      throw new Error('database configuration is required');
    }
    
    if (!envConfig.ecs) {
      throw new Error('ecs configuration is required');
    }
    parseWebPlugins(envConfig.cloudtak.webPlugins);
    ConfigValidator.validateBreakGlass(envConfig);
  }

  /** The break-glass settings are optional, but a value that is present must be usable. */
  static validateBreakGlass(envConfig: ContextEnvironmentConfig): void {
    const settings = envConfig.cloudtak.breakGlass;
    if (!settings) return;
    for (const email of settings.alertEmails ?? []) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error(`cloudtak.breakGlass.alertEmails: "${email}" is not an email address`);
      }
    }
    const principals = (settings.roleTrustedPrincipals ?? []).filter(Boolean);
    for (const arn of principals) {
      if (!/^arn:aws[a-z-]*:iam::\d{12}:(role|user)\/.+$/.test(arn)) {
        throw new Error(`cloudtak.breakGlass.roleTrustedPrincipals: "${arn}" is not an IAM role or user ARN`);
      }
    }
    const patterns = (settings.roleTrustedPrincipalPatterns ?? []).filter(Boolean);
    for (const pattern of patterns) {
      // The account must be spelled out, and enough of the role name before the first wildcard that the pattern
      // names one permission set or role family, not "any role" or "any role starting with a".
      const match = /^arn:aws[a-z-]*:iam::\d{12}:role\/([^*]*)/.exec(pattern);
      if (!match || match[1].length < 20 || /\s/.test(pattern)) {
        throw new Error(
          `cloudtak.breakGlass.roleTrustedPrincipalPatterns: "${pattern}" must be an IAM role ARN with the account id, ` +
          'and at least 20 characters of the role path and name before any wildcard ' +
          '(for example arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/ap-southeast-2/AWSReservedSSO_Admin_*)'
        );
      }
    }
    if (settings.roleRequireMfa === false && principals.length === 0 && patterns.length === 0) {
      throw new Error(
        'cloudtak.breakGlass.roleRequireMfa=false needs roleTrustedPrincipals or roleTrustedPrincipalPatterns: without ' +
        'named principals the role trusts the whole account, and that must require MFA'
      );
    }
  }
}