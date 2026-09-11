/**
 * Full-stack synth-smoke + behavioral/safety assertions for CloudTakStack.
 *
 * These are the highest-value CDK tests in the suite: the synth-smoke cases
 * catch the failure that actually happens in practice (a stack that no longer
 * synthesizes), and the behavioral cases assert only properties whose meaning
 * goes beyond restating construct code — prod data-loss safety, feature-flag
 * wiring, and the cross-stack export contract other stacks import by name.
 *
 * Each stack variant is synthesized once and the resulting Template is reused
 * across assertions, so the whole file pays for roughly four synths.
 */
import { Template, Match } from 'aws-cdk-lib/assertions';
import { synthTemplate, EnvType } from '../__helpers__/synth-stack';

// The prebuilt-image path resolves image tags from a cloudtakImageTag context
// value that CI supplies (e.g. `cloudtak-<sha>`); without it the events and
// retention services throw at synth. Mirror that here.
const PREBUILT_CONTEXT = { usePreBuiltImages: true, cloudtakImageTag: 'cloudtak-testsha' };
const LOCAL_CONTEXT = { usePreBuiltImages: false };

// Cache one Template per variant so the file synthesizes each stack only once.
const cache = new Map<string, Template>();
function template(envType: EnvType, prebuilt: boolean): Template {
  const key = `${envType}:${prebuilt}`;
  if (!cache.has(key)) {
    cache.set(key, synthTemplate(envType, prebuilt ? PREBUILT_CONTEXT : LOCAL_CONTEXT));
  }
  return cache.get(key)!;
}

describe('CloudTakStack synth smoke', () => {
  // Each environment, each image path. If the stack stops synthesizing, this
  // is the first thing that goes red.
  it.each([
    ['dev-test', false],
    ['dev-test', true],
    ['prod', false],
    ['prod', true],
  ] as [EnvType, boolean][])(
    'synthesizes for %s (prebuilt images=%s)',
    (envType, prebuilt) => {
      expect(() => template(envType, prebuilt)).not.toThrow();
    }
  );
});

describe('database safety shape', () => {
  it('prod cluster has deletion protection and provisioned instances', () => {
    const t = template('prod', true);

    t.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      DeletionProtection: true,
    });

    // prod runs provisioned instances (cdk.json: instanceClass db.t4g.large,
    // instanceCount 2), not serverless. Shipping prod as serverless/single is a
    // real regression.
    t.resourceCountIs('AWS::RDS::DBInstance', 2);
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.t4g.large',
    });
  });

  it('dev-test cluster is destroyable and serverless', () => {
    const t = template('dev-test', true);

    // dev-test must NOT carry deletion protection — otherwise teardown of
    // ephemeral environments silently fails.
    t.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      DeletionProtection: false,
      ServerlessV2ScalingConfiguration: Match.anyValue(),
    });

    // Serverless v2 still materializes a single writer instance, on the
    // db.serverless class rather than a provisioned instance type.
    t.resourceCountIs('AWS::RDS::DBInstance', 1);
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.serverless',
    });
  });
});

describe('feature-flag-gated wiring: usePreBuiltImages', () => {
  // The flag switches the container image source. We detect the branch from the
  // ECS task-definition container images:
  //  - local build   -> images point at the CDK bootstrap asset repo
  //                      (cdk-hnb659fds-container-assets-...)
  //  - prebuilt (CI)  -> images resolve from the imported BaseInfra ECR repo
  //                      (TAK-<Env>-BaseInfra-EcrArtifactsRepoArn)
  const BOOTSTRAP_ASSET_REPO = 'container-assets';
  const BASEINFRA_ECR_IMPORT = 'BaseInfra-EcrArtifactsRepoArn';

  function containerImagesJson(t: Template): string {
    const resources = t.toJSON().Resources as Record<string, any>;
    const images: unknown[] = [];
    for (const r of Object.values(resources)) {
      if (r.Type === 'AWS::ECS::TaskDefinition') {
        for (const c of r.Properties?.ContainerDefinitions ?? []) {
          images.push(c.Image);
        }
      }
    }
    return JSON.stringify(images);
  }

  it('local build path sources images from CDK Docker assets', () => {
    const images = containerImagesJson(template('dev-test', false));
    expect(images).toContain(BOOTSTRAP_ASSET_REPO);
    expect(images).not.toContain(BASEINFRA_ECR_IMPORT);
  });

  it('prebuilt path sources images from the imported BaseInfra ECR repo', () => {
    const images = containerImagesJson(template('dev-test', true));
    expect(images).toContain(BASEINFRA_ECR_IMPORT);
    expect(images).not.toContain(BOOTSTRAP_ASSET_REPO);
  });
});

describe('cross-stack export contract', () => {
  // Other stacks import these by name. A rename here breaks a consumer stack,
  // so the export names are a contract worth pinning. Names are derived from
  // envConfig.stackName ('Prod') and the stack name ('TAK-Prod-CloudTAK').
  it('exports the names consumer stacks import', () => {
    const t = template('prod', true);
    const outputs = (t.toJSON().Outputs ?? {}) as Record<string, any>;
    const exportNames = Object.values(outputs)
      .map((o) => o.Export?.Name)
      .filter(Boolean);

    const expected = [
      'TAK-Prod-CloudTAK-ApiURL',
      'TAK-Prod-CloudTAK-SigningSecret',
      'TAK-Prod-CloudTAK-MediaSecret',
      'TAK-Prod-CloudTAK-EtlEcrRepoArn',
      'TAK-Prod-CloudTAK-MediaUrl',
      'TAK-Prod-CloudTAK-etl-role',
      'TAK-Prod-CloudTAK-ServiceURL',
      'TAK-Prod-CloudTAK-DatabaseEndpoint',
      'TAK-Prod-CloudTAK-AssetBucket',
    ];

    for (const name of expected) {
      expect(exportNames).toContain(name);
    }
  });
});
