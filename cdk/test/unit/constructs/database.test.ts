import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Database } from '../../../lib/constructs/database';
import { CDKTestHelper } from '../../__helpers__/cdk-test-utils';
import { MOCK_CONFIGS } from '../../__fixtures__/mock-configs';

describe('Database Construct', () => {
  it('creates serverless database for dev-test', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack1', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    const infrastructure = CDKTestHelper.createMockInfrastructure(stack);
    const { vpc, kmsKey, ecsSecurityGroup } = infrastructure;

    const database = new Database(stack, 'TestDatabase', {
      environment: 'dev-test',
      envConfig: MOCK_CONFIGS.DEV_TEST,
      vpc,
      kmsKey,
      securityGroups: [ecsSecurityGroup]
    });

    expect(database.cluster).toBeDefined();
    expect(database.masterSecret).toBeDefined();
    expect(database.hostname).toBeDefined();

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      DatabaseName: 'tak_ps_etl'
    });
  });

  it('creates provisioned database for prod', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack2', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    const infrastructure = CDKTestHelper.createMockInfrastructure(stack);
    const { vpc, kmsKey, ecsSecurityGroup } = infrastructure;

    new Database(stack, 'TestDatabase', {
      environment: 'prod',
      envConfig: MOCK_CONFIGS.PROD,
      vpc,
      kmsKey,
      securityGroups: [ecsSecurityGroup]
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      DeletionProtection: true
    });
  });

  it('throws error when database config is missing', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack3');
    const infrastructure = CDKTestHelper.createMockInfrastructure(stack);
    const { vpc, kmsKey, ecsSecurityGroup } = infrastructure;

    const invalidConfig = { ...MOCK_CONFIGS.DEV_TEST };
    delete (invalidConfig as any).database;

    expect(() => {
      new Database(stack, 'TestDatabase', {
        environment: 'dev-test',
        envConfig: invalidConfig,
        vpc,
        kmsKey,
        securityGroups: [ecsSecurityGroup]
      });
    }).toThrow('Database configuration is required when using Database construct');
  });

  it('creates database with performance insights enabled', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack4', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    const infrastructure = CDKTestHelper.createMockInfrastructure(stack);
    const { vpc, kmsKey, ecsSecurityGroup } = infrastructure;
    const configWithInsights = { ...MOCK_CONFIGS.PROD };
    configWithInsights.database.enablePerformanceInsights = true;
    configWithInsights.database.monitoringInterval = 60;

    new Database(stack, 'TestDatabase', {
      environment: 'prod',
      envConfig: configWithInsights,
      vpc,
      kmsKey,
      securityGroups: [ecsSecurityGroup]
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      EnablePerformanceInsights: true,
      MonitoringInterval: 60
    });
  });

  it('derives engine version and parameter group family from config (Aurora PG 18)', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStackPg18', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    const infrastructure = CDKTestHelper.createMockInfrastructure(stack);
    const { vpc, kmsKey, ecsSecurityGroup } = infrastructure;

    new Database(stack, 'TestDatabase', {
      environment: 'prod',
      envConfig: MOCK_CONFIGS.PROD,
      vpc,
      kmsKey,
      securityGroups: [ecsSecurityGroup]
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      EngineVersion: '18.6'
    });
    template.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Family: 'aurora-postgresql18',
      Parameters: Match.objectLike({
        shared_preload_libraries: 'pg_stat_statements',
        log_connections: 'all'
      })
    });

    // Parameter group must not have a fixed physical name, otherwise a family
    // change (replacement) would collide with the old group.
    const groups = template.findResources('AWS::RDS::DBClusterParameterGroup');
    for (const group of Object.values(groups)) {
      expect((group as any).Properties.DBClusterParameterGroupName).toBeUndefined();
    }
  });
});
