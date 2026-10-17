/**
 * Helpers for the optional WEB_PLUGINS Docker build argument.
 *
 * The value uses the same format as the Dockerfile's WEB_PLUGINS build arg
 * (consumed by api/bin/plugin.ts): git URLs separated by commas and/or
 * whitespace. Only plain https GitHub URLs are accepted.
 */
import { Construct } from 'constructs';

const WEB_PLUGIN_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?$/;

/**
 * Split a WEB_PLUGINS string into URLs and validate each one.
 * Throws if any entry is not an https GitHub repository URL.
 */
export function parseWebPlugins(value: string | undefined): string[] {
  const entries = (value ?? '').split(/[,\s]+/).filter(Boolean);
  for (const entry of entries) {
    if (!WEB_PLUGIN_URL.test(entry)) {
      // Mask anything that looks like credentials so they never reach logs.
      const shown = entry.replace(/\/\/[^/@]*@/, '//***@');
      throw new Error(
        `Invalid web plugin URL '${shown}'. Each entry must be an https GitHub URL ` +
        `such as https://github.com/<owner>/<repo>.git (no credentials, refs, or other schemes).`
      );
    }
  }
  return entries;
}

/**
 * Resolve the effective WEB_PLUGINS value.
 * Precedence: --context WebPlugins (or webPlugins), then the WEB_PLUGINS
 * environment variable, then the per-environment cdk.json value.
 * Returns the validated, comma-joined list ('' when none are configured).
 */
export function resolveWebPlugins(scope: Construct, configValue?: string): string {
  const contextValue = scope.node.tryGetContext('WebPlugins') ?? scope.node.tryGetContext('webPlugins');
  const raw = contextValue !== undefined
    ? String(contextValue)
    : (process.env.WEB_PLUGINS ?? configValue ?? '');
  return parseWebPlugins(raw).join(',');
}
