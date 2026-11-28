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
    if (settings.roleRequireMfa === false && principals.length === 0) {
      throw new Error(
        'cloudtak.breakGlass.roleRequireMfa=false needs roleTrustedPrincipals: without named principals the role trusts ' +
        'the whole account, and that must require MFA'
      );
    }
  }
}