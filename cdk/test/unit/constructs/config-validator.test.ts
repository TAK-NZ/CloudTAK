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
});