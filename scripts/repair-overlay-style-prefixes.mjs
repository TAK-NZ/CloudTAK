#!/usr/bin/env node
/*
 * Collapse repeated layer-id prefixes in profile_overlays.styles.
 *
 * Overlay.replace() used to prefix layer ids in the array its *caller* owned.
 * MenuBasemaps passes `basemap.styles` straight out of component state, so
 * re-selecting the same basemap prefixed the same array again, and the result is
 * PATCHed back to the server - producing `23-23-23-Background` after three
 * clicks, uniformly across every layer.
 *
 * Fixed in api/web/src/base/overlay-class.ts (namespaceStyles: copies rather than
 * mutates, and is idempotent). This repairs rows already written.
 *
 * Reports by default. Set APPLY=1 to write, transactionally.
 *
 *   POSTGRES='postgres://...' node scripts/repair-overlay-style-prefixes.mjs
 *   POSTGRES='postgres://...' APPLY=1 node scripts/repair-overlay-style-prefixes.mjs
 */
import postgres from 'postgres';

if (!process.env.POSTGRES) {
    console.error('POSTGRES is not set');
    process.exit(2);
}

const apply = process.env.APPLY === '1';
const sql = postgres(process.env.POSTGRES, { idle_timeout: 5, max: 1 });

const rows = await sql`
    select id, name, styles from profile_overlays
    where styles is not null and jsonb_typeof(styles) = 'array'
    order by id
`;

/** How many times `${id}-` repeats at the head of a layer id. */
function depth(value, prefix) {
    let n = 0;
    let rest = String(value);
    while (rest.startsWith(prefix)) {
        n++;
        rest = rest.slice(prefix.length);
    }
    return n;
}

const plan = [];

for (const row of rows) {
    const prefix = `${row.id}-`;
    const styles = row.styles;
    if (!Array.isArray(styles) || !styles.length) continue;

    const depths = new Set(styles.map((l) => depth(l.id, prefix)));
    const maxDepth = Math.max(...depths);
    if (maxDepth <= 1) continue;

    // Collapse to exactly one prefix. Layer ids are namespaced per overlay, so a
    // single leading `${id}-` is the correct end state.
    const repaired = styles.map((l) => {
        let id = String(l.id);
        while (depth(id, prefix) > 1) id = id.slice(prefix.length);
        return { ...l, id };
    });

    plan.push({
        id: row.id,
        name: row.name,
        layers: styles.length,
        depths: [...depths].sort(),
        sampleBefore: styles[0].id,
        sampleAfter: repaired[0].id,
        repaired
    });
}

if (!plan.length) {
    console.log(`checked ${rows.length} overlay row(s) with styles - none over-prefixed`);
    await sql.end();
    process.exit(0);
}

console.log(`checked ${rows.length} overlay row(s) with styles\n`);
for (const p of plan) {
    console.log(`  overlay ${p.id} "${p.name}"`);
    console.log(`    layers=${p.layers} prefix depths present=${JSON.stringify(p.depths)}`);
    console.log(`    ${p.sampleBefore}  ->  ${p.sampleAfter}`);
}

if (!apply) {
    console.log('\nreport only - set APPLY=1 to write');
    await sql.end();
    process.exit(1);
}

await sql.begin(async (tx) => {
    for (const p of plan) {
        await tx`update profile_overlays set styles = ${sql.json(p.repaired)} where id = ${p.id}`;
    }
});

// Re-read and confirm
let bad = 0;
for (const p of plan) {
    const [after] = await sql`select id, styles from profile_overlays where id = ${p.id}`;
    const prefix = `${after.id}-`;
    const worst = Math.max(...after.styles.map((l) => depth(l.id, prefix)));
    console.log(`  overlay ${after.id}: max prefix depth now ${worst}`);
    if (worst > 1) bad++;
}

await sql.end();
console.log(bad ? '\nFAILED - some rows are still over-prefixed' : '\nrepaired');
process.exit(bad ? 1 : 0);
