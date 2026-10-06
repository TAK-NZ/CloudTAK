/**
 * Full-stack synth helper.
 *
 * Reads the real environment context block out of cdk.json (the same config a
 * deploy uses), applies the standard context overrides, and synthesizes the
 * whole CloudTakStack with an explicit account/region so that
 * `stack.availabilityZones` resolves to concrete AZs instead of the
 * agnostic-stack dummy tokens. Returns the CloudFormation Template so callers
 * can make targeted assertions; building the Template is itself the synth, so
 * "synthesizes without throwing" comes for free.
 */
import * as fs from 'fs';
import * as path from 'path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CloudTakStack } from '../../lib/cloudtak-stack';
import { applyContextOverrides } from '../../lib/utils/context-overrides';
import { generateStandardTags } from '../../lib/utils/tag-helpers';
import type { ContextEnvironmentConfig } from '../../lib/stack-config';

export type EnvType = 'dev-test' | 'prod';

const TEST_ENV = { account: '123456789012', region: 'ap-southeast-2' };

/** Read the full context object from the repo's cdk.json exactly as deploys do. */
function loadCdkContext(): Record<string, unknown> {
  const cdkJsonPath = path.resolve(__dirname, '../../cdk.json');
  const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, 'utf-8'));
  return cdkJson.context as Record<string, unknown>;
}

/**
 * Synthesize CloudTakStack for the given environment.
 *
 * @param envType       'dev-test' or 'prod' — selects the cdk.json context block.
 * @param extraContext  extra CDK context (e.g. { usePreBuiltImages: true }) merged
 *                      on top of the env's config, mirroring `--context` flags.
 */
export function synthTemplate(
  envType: EnvType,
  extraContext: Record<string, unknown> = {}
): Template {
  return synthStack(envType, extraContext).template;
}

/**
 * Like synthTemplate, but also returns the stack-level tags. bin/cdk.ts passes
 * generateStandardTags() as the stack `tags` prop; CloudFormation propagates
 * those to every resource at deploy time without them appearing in the
 * template, so they must be exercised here too.
 */
export function synthStack(
  envType: EnvType,
  extraContext: Record<string, unknown> = {}
): { template: Template; stackTags: Record<string, string> } {
  const context = { ...loadCdkContext(), ...extraContext };
  const app = new App({ context });
  const baseConfig = app.node.tryGetContext(envType) as ContextEnvironmentConfig;
  const envConfig = applyContextOverrides(app, baseConfig);
  const stack = new CloudTakStack(app, `TAK-${envConfig.stackName}-CloudTAK`, {
    environment: envType,
    envConfig,
    env: TEST_ENV,
    // Same as bin/cdk.ts
    tags: generateStandardTags(envConfig, envType, context['tak-defaults'] as never),
  });
  return { template: Template.fromStack(stack), stackTags: stack.tags.tagValues() };
}
