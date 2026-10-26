/**
 * TAK-NZ: separator that turns a flat channel name into a folder hierarchy,
 * e.g. "BCH - Alerts - MetService" is the channel "MetService" in the folder
 * "Alerts" in the folder "BCH". Set it with CHANNEL_FOLDER_SEPARATOR in the
 * cloudtak-config.env file in S3, the same variable TAK Team Manager reads, so
 * both apps split names the same way.
 *
 * Rules:
 * - Unset, empty, or whitespace-only (after quote stripping): the default ' - '.
 * - One matched pair of surrounding quotes (" or ') is removed and inner
 *   whitespace is kept, so `" - "` becomes ` - `. ECS does not strip quotes from
 *   KEY="value" lines in an env file, so the literal quotes would otherwise end
 *   up in the separator and no channel name would split.
 * - An unmatched quote, or a quote inside the value, is kept as written.
 * - The value is never trimmed and this function never throws.
 */
export const DEFAULT_CHANNEL_FOLDER_SEPARATOR = ' - ';

export function stripOneMatchedQuotePair(value: string): string {
    if (value.length < 2) return value;

    const first = value[0];
    const last = value[value.length - 1];

    if ((first === '"' || first === '\'') && first === last) {
        return value.slice(1, -1);
    }

    return value;
}

export function resolveChannelFolderSeparator(env: NodeJS.ProcessEnv = process.env): string {
    const raw = env.CHANNEL_FOLDER_SEPARATOR;

    if (typeof raw !== 'string' || raw === '') return DEFAULT_CHANNEL_FOLDER_SEPARATOR;

    const unquoted = stripOneMatchedQuotePair(raw);

    // A separator with no visible character is a misconfiguration, not a request
    // to split on whitespace
    if (unquoted.trim() === '') return DEFAULT_CHANNEL_FOLDER_SEPARATOR;

    return unquoted;
}
