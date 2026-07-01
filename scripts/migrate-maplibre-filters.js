#!/usr/bin/env node
/**
 * migrate-maplibre-filters.js
 *
 * Converts deprecated MapLibre GL legacy filter syntax to modern expression syntax.
 * Required for MapLibre GL v3+ which no longer allows mixing legacy and expression syntax.
 *
 * Legacy → Expression conversions applied:
 *   ["==",  prop, value]          → ["==",  ["get", prop], value]
 *   ["!=",  prop, value]          → ["!=",  ["get", prop], value]
 *   ["<",   prop, value]          → ["<",   ["get", prop], value]
 *   [">",   prop, value]          → [">",   ["get", prop], value]
 *   ["<=",  prop, value]          → ["<=",  ["get", prop], value]
 *   [">=",  prop, value]          → [">=",  ["get", prop], value]
 *   ["in",  prop, v1, v2, ...]    → ["in",  ["get", prop], ["literal", [v1, v2, ...]]]
 *   ["!in", prop, v1, v2, ...]    → ["!",   ["in", ["get", prop], ["literal", [v1, v2, ...]]]]
 *   ["!has", prop]                → ["!",   ["has", prop]]
 *
 * Combinatorial operators (all, any, none) are recursed into but not changed.
 * "has", "!=" with non-string LHS, and already-migrated expressions are left unchanged.
 *
 * Usage:
 *   # Migrate a single file (writes to <file>.migrated.json):
 *   node migrate-maplibre-filters.js style.json
 *
 *   # Migrate multiple files (in-place with .bak backup):
 *   node migrate-maplibre-filters.js --in-place style1.json style2.json style3.json
 *
 *   # Migrate all .json files in a directory:
 *   node migrate-maplibre-filters.js --in-place ./styles/*.json
 *
 *   # Dry-run: print migrated JSON to stdout without writing:
 *   node migrate-maplibre-filters.js --stdout style.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import process from 'node:process';

const COMPARISON_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);

/**
 * Recursively migrate a single filter expression.
 * @param {any} f
 * @returns {any}
 */
function migrate(f) {
    if (!Array.isArray(f) || f.length === 0) return f;

    const op = f[0];

    // Recurse into combinatorial operators
    if (op === 'all' || op === 'any' || op === 'none') {
        return [op, ...f.slice(1).map(migrate)];
    }

    // ["!has", prop] → ["!", ["has", prop]]
    if (op === '!has' && f.length === 2) {
        return ['!', ['has', f[1]]];
    }

    // ["has", prop] — valid in both syntaxes, leave as-is
    if (op === 'has') {
        return f;
    }

    // Binary comparison: ["OP", prop_string, value] → ["OP", ["get", prop], value]
    if (COMPARISON_OPS.has(op) && f.length === 3 && typeof f[1] === 'string') {
        return [op, ['get', f[1]], f[2]];
    }

    // ["in", prop_string, v1, v2, ...] → ["in", ["get", prop], ["literal", [v1, ...]]]
    if (op === 'in' && f.length >= 2 && typeof f[1] === 'string') {
        return ['in', ['get', f[1]], ['literal', f.slice(2)]];
    }

    // ["!in", prop_string, v1, v2, ...] → ["!", ["in", ["get", prop], ["literal", [...]]]]
    if (op === '!in' && f.length >= 2 && typeof f[1] === 'string') {
        return ['!', ['in', ['get', f[1]], ['literal', f.slice(2)]]];
    }

    // Anything else (already expression syntax, or unrecognised) — leave unchanged
    return f;
}

/**
 * Migrate all layer filters in a style layers array.
 * Accepts either a full style object or a bare layers array.
 * @param {object|Array} styleOrLayers
 * @returns {{ result: object|Array, count: number }}
 */
function migrateStyle(styleOrLayers) {
    let result;
    let count = 0;

    const migrateLayers = (layers) => {
        return layers.map((layer) => {
            if (!layer.filter) return layer;
            const original = JSON.stringify(layer.filter);
            const migrated = migrate(layer.filter);
            if (JSON.stringify(migrated) !== original) count++;
            return { ...layer, filter: migrated };
        });
    };

    if (Array.isArray(styleOrLayers)) {
        // Bare layers array
        result = migrateLayers(styleOrLayers);
    } else if (styleOrLayers && Array.isArray(styleOrLayers.layers)) {
        // Full style object
        result = { ...styleOrLayers, layers: migrateLayers(styleOrLayers.layers) };
    } else {
        throw new Error('Input must be a layers array or a style object with a "layers" property');
    }

    return { result, count };
}

/**
 * Process a single file.
 */
function processFile(filePath, opts) {
    const abs = resolve(filePath);

    if (!existsSync(abs)) {
        console.error(`  ERROR: file not found: ${abs}`);
        return false;
    }

    let raw;
    try {
        raw = readFileSync(abs, 'utf8');
    } catch (err) {
        console.error(`  ERROR reading ${abs}: ${err.message}`);
        return false;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        console.error(`  ERROR parsing JSON in ${abs}: ${err.message}`);
        return false;
    }

    let result, count;
    try {
        ({ result, count } = migrateStyle(parsed));
    } catch (err) {
        console.error(`  ERROR migrating ${abs}: ${err.message}`);
        return false;
    }

    const output = JSON.stringify(result, null, 4) + '\n';

    if (opts.stdout) {
        process.stdout.write(output);
        console.error(`  [${basename(abs)}] ${count} filter(s) migrated (stdout)`);
        return true;
    }

    if (opts.inPlace) {
        // Write backup
        const backupPath = abs + '.bak';
        writeFileSync(backupPath, raw, 'utf8');
        writeFileSync(abs, output, 'utf8');
        console.log(`  [${basename(abs)}] ${count} filter(s) migrated  (backup → .bak)`);
    } else {
        // Write to <name>.migrated.json alongside original
        const outPath = resolve(dirname(abs), basename(abs).replace(/\.json$/, '') + '.migrated.json');
        writeFileSync(outPath, output, 'utf8');
        console.log(`  [${basename(abs)}] ${count} filter(s) migrated  → ${basename(outPath)}`);
    }

    return true;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  node migrate-maplibre-filters.js [options] <file(s)>

Options:
  --in-place   Overwrite source files (a .bak backup is created first)
  --stdout     Print migrated JSON to stdout (single file only)
  --help       Show this message

Examples:
  node migrate-maplibre-filters.js style.json
  node migrate-maplibre-filters.js --in-place styles/*.json
  node migrate-maplibre-filters.js --stdout style.json | jq .
`);
    process.exit(0);
}

const opts = {
    inPlace: args.includes('--in-place'),
    stdout:  args.includes('--stdout'),
};

const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
    console.error('No input files specified. Use --help for usage.');
    process.exit(1);
}

if (opts.stdout && files.length > 1) {
    console.error('--stdout only supports a single input file.');
    process.exit(1);
}

console.log(`Migrating ${files.length} file(s)...`);
let errors = 0;
for (const f of files) {
    if (!processFile(f, opts)) errors++;
}

if (errors > 0) {
    console.error(`\n${errors} file(s) had errors.`);
    process.exit(1);
} else {
    console.log('Done.');
}
