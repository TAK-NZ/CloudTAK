import test from 'node:test';
import assert from 'node:assert';
import { asTakGroup, asTakRole } from '../stateless/lib/authentik-provider.js';

/**
 * Regression coverage for an outage where an Authentik `takColor` attribute
 * set to the literal string "None" (consistent with an external script
 * doing something like `str(some_attr)` on an unset attribute) was written
 * straight through to a user's ProfileConfig. `tak_group` is stored as free
 * text but `GET /api/profile`'s response schema validates it against the
 * TAKGroup enum, so the bad value made every subsequent profile fetch for
 * that user fail with a 400 - the map could never boot, since it depends on
 * a successful profile fetch during login. Nothing on the write path
 * validated the attribute before this fix.
 */

test('asTakGroup: accepts every real TAK team colour', () => {
    for (const group of [
        'White', 'Yellow', 'Orange', 'Magenta', 'Red', 'Maroon', 'Purple',
        'Dark Blue', 'Blue', 'Cyan', 'Teal', 'Green', 'Dark Green', 'Brown',
    ]) {
        assert.equal(asTakGroup(group, 'user@example.com'), group);
    }
});

test('asTakGroup: rejects the literal string "None" - the actual outage value', () => {
    assert.equal(asTakGroup('None', 'user@example.com'), undefined);
});

test('asTakGroup: rejects an arbitrary invalid string', () => {
    assert.equal(asTakGroup('Not A Colour', 'user@example.com'), undefined);
});

test('asTakGroup: rejects empty string, undefined, null and non-string values', () => {
    assert.equal(asTakGroup('', 'user@example.com'), undefined);
    assert.equal(asTakGroup(undefined, 'user@example.com'), undefined);
    assert.equal(asTakGroup(null, 'user@example.com'), undefined);
    assert.equal(asTakGroup(42, 'user@example.com'), undefined);
    assert.equal(asTakGroup(['Blue'], 'user@example.com'), undefined);
});

test('asTakGroup: is case-sensitive - Authentik attributes must match the enum exactly', () => {
    assert.equal(asTakGroup('blue', 'user@example.com'), undefined);
    assert.equal(asTakGroup('BLUE', 'user@example.com'), undefined);
});

test('asTakRole: accepts every real TAK role', () => {
    for (const role of [
        'Team Member', 'Team Lead', 'HQ', 'Sniper', 'Medic',
        'Forward Observer', 'RTO', 'K9',
    ]) {
        assert.equal(asTakRole(role, 'user@example.com'), role);
    }
});

test('asTakRole: rejects the literal string "None"', () => {
    assert.equal(asTakRole('None', 'user@example.com'), undefined);
});

test('asTakRole: rejects an arbitrary invalid string', () => {
    assert.equal(asTakRole('Not A Role', 'user@example.com'), undefined);
});

test('asTakRole: rejects empty string, undefined, null and non-string values', () => {
    assert.equal(asTakRole('', 'user@example.com'), undefined);
    assert.equal(asTakRole(undefined, 'user@example.com'), undefined);
    assert.equal(asTakRole(null, 'user@example.com'), undefined);
    assert.equal(asTakRole(7, 'user@example.com'), undefined);
});
