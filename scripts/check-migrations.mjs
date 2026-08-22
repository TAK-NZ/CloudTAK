#!/usr/bin/env node
/*
 * Pre-flight migration audit.
 *
 * Drizzle decides what to apply by comparing each journal entry's `when`
 * against max(created_at) in drizzle.__drizzle_migrations. It is a high-water
 * mark, not set membership - so if a row ever lands with a timestamp above an
 * unapplied migration, that migration is skipped permanently and silently. No
 * error, no warning, on every subsequent run.
 *
 * That is not hypothetical. The PDX database was missing 0115/0116/0117 - the
 * three that create `profile_videos` - from August 2025 until the v13.70.0
 * upgrade tripped over it in 0187 and rolled the deploy back. The cause was a
 * fork-local migration whose timestamp was hand-picked one millisecond after an
 * upstream one, which pushed the high-water mark past all three.
 *
 * Run this against every environment before upgrading it.
 *
 *   POSTGRES='postgres://...' node scripts/check-migrations.mjs
 *
 * In AWS the database is not reachable directly; go through the running task:
 *
 *   aws ecs execute-command --cluster <cluster> --task <id> --container api \
 *     --interactive --command "/bin/sh -c 'cd /home/etl/api && node <this>'"
 *
 * Exit codes: 0 clean, 1 problems found, 2 could not run the check.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import postgres from 'postgres';

const here = path.dirname(url.fileURLToPath(import.meta.url));

function findJournal() {
    // Set this to pre-flight a *new* version against a *current* database, which
    // is the case that matters: point it at the target release's journal while
    // the running container still has the old one. Without it the audit only
    // tells you the deployed version is self-consistent.
    if (process.env.MIGRATIONS_JOURNAL) return process.env.MIGRATIONS_JOURNAL;

    const candidates = [
        path.join(here, '..', 'api', 'migrations', 'meta', '_journal.json'),
        path.join(here, 'migrations', 'meta', '_journal.json'),
        path.join(process.cwd(), 'migrations', 'meta', '_journal.json'),
        path.join(process.cwd(), 'api', 'migrations', 'meta', '_journal.json')
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    throw new Error(`could not find migrations/meta/_journal.json, looked in:\n  ${candidates.join('\n  ')}`);
}

if (!process.env.POSTGRES) {
    console.error('POSTGRES is not set');
    process.exit(2);
}

let journalPath;
try {
    journalPath = findJournal();
} catch (err) {
    console.error(String(err.message ?? err));
    process.exit(2);
}

const entries = JSON.parse(fs.readFileSync(journalPath, 'utf8')).entries;
const byWhen = new Map(entries.map((e) => [Number(e.when), e]));

const sql = postgres(process.env.POSTGRES, { idle_timeout: 5, max: 1 });

let applied;
try {
    applied = (await sql`
        select created_at from drizzle.__drizzle_migrations order by created_at asc
    `).map((r) => Number(r.created_at));
} catch (err) {
    console.error(`could not read drizzle.__drizzle_migrations: ${err.message ?? err}`);
    await sql.end();
    process.exit(2);
}
await sql.end();

if (!applied.length) {
    console.log('database has no migration history - it will be migrated from scratch, nothing to audit');
    process.exit(0);
}

const appliedSet = new Set(applied);
const highWater = Math.max(...applied);
const hwEntry = byWhen.get(highWater);

// The failure mode: a journal entry below the high-water mark that was never
// recorded. Drizzle will never revisit it.
const orphaned = entries.filter((e) => Number(e.when) < highWater && !appliedSet.has(Number(e.when)));

// Rows with no journal counterpart. Usually a fork-local or re-timestamped
// migration whose file is gone. Harmless on its own, but it is how orphaning
// happens, so it is worth surfacing.
const unknown = applied.filter((w) => !byWhen.has(w));

const pending = entries.filter((e) => Number(e.when) > highWater);

console.log(`journal:     ${entries.length} entries (${path.relative(process.cwd(), journalPath)})`);
console.log(`applied:     ${applied.length} rows`);
console.log(`high-water:  ${highWater}${hwEntry ? ` (${hwEntry.tag})` : ' (no journal entry - see below)'}`);
console.log(`pending:     ${pending.length}${pending.length ? ` -> ${pending[0].tag} .. ${pending[pending.length - 1].tag}` : ''}`);

if (unknown.length) {
    console.log(`\nrows with no journal entry (${unknown.length}):`);
    for (const w of unknown) {
        let nearest = null;
        for (const e of entries) {
            if (!nearest || Math.abs(Number(e.when) - w) < Math.abs(Number(nearest.when) - w)) nearest = e;
        }
        const delta = w - Number(nearest.when);
        console.log(`  ${w}  nearest: ${nearest.tag} (${nearest.when}, ${delta >= 0 ? '+' : ''}${delta} ms)`);
    }
    console.log('  These are usually retired fork-local migrations. A tiny offset from an');
    console.log('  upstream entry means the timestamp was hand-picked, which is what orphans');
    console.log('  later-arriving upstream migrations.');
}

if (orphaned.length) {
    console.error(`\nORPHANED: ${orphaned.length} migration(s) below the high-water mark were never applied`);
    console.error('and drizzle will never apply them. The schema is missing whatever they create.\n');
    for (const e of orphaned) {
        console.error(`  idx ${String(e.idx).padStart(4)}  ${e.tag.padEnd(42)} when=${e.when}`);
    }
    console.error('\nApply them by hand, in journal order, before upgrading this environment.');
    console.error('Record them afterwards so this audit stays clean: drizzle only ever reads');
    console.error('max(created_at), so inserting the rows changes no behaviour.');
    process.exit(1);
}

console.log('\nOK - every journal entry below the high-water mark is recorded.');
process.exit(0);
