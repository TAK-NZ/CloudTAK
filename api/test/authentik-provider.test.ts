import test from 'node:test';
import assert from 'node:assert';
import {
    asTakGroup,
    asTakRole,
    agencyScope,
    agencyInScope,
    SCOPE_ALL,
    machineUsernameFor,
    machineUsernameFromCertSubject,
    isMachineUser,
    channelGroupName,
} from '../stateless/lib/authentik-provider.js';

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

/**
 * Agency scoping — the guard behind the privilege-escalation fix.
 *
 * The ETL agency/channel listings and machine-user creation used to ignore the
 * caller's CloudTAK role and return/allow everything. agencyInScope() is the
 * predicate the provider now applies to every agency group (agencies()) and to
 * a channel group's owning-agency FK (channels()). If this predicate is wrong,
 * a non-system-admin agency admin either sees agencies/channels they shouldn't
 * (the original bug) or is locked out of their own.
 */

test('agencyInScope: system-admin scope sees every agency', () => {
    assert.equal(agencyInScope(SCOPE_ALL, 1), true);
    assert.equal(agencyInScope(SCOPE_ALL, 999), true);
    // Even a missing/garbage id is "visible" to a system admin.
    assert.equal(agencyInScope(SCOPE_ALL, undefined), true);
});

test('agencyInScope: scoped caller sees only their agencies', () => {
    const scope = agencyScope([1, 3]);
    assert.equal(agencyInScope(scope, 1), true);
    assert.equal(agencyInScope(scope, 3), true);
    assert.equal(agencyInScope(scope, 2), false);
    assert.equal(agencyInScope(scope, 4), false);
});

test('agencyInScope: an empty scope (no agency_admin) sees nothing', () => {
    const scope = agencyScope([]);
    assert.equal(agencyInScope(scope, 1), false);
    assert.equal(agencyInScope(scope, 0), false);
});

test('agencyInScope: coerces numeric-string ids (Authentik attributes are free text)', () => {
    const scope = agencyScope([1]);
    assert.equal(agencyInScope(scope, '1'), true);
    assert.equal(agencyInScope(scope, '2'), false);
});

test('agencyInScope: rejects a missing or non-numeric agencyId for a scoped caller', () => {
    const scope = agencyScope([1]);
    assert.equal(agencyInScope(scope, undefined), false);
    assert.equal(agencyInScope(scope, null), false);
    assert.equal(agencyInScope(scope, 'not-a-number'), false);
    // NaN must never match a scoped caller (would otherwise leak unowned groups).
    assert.equal(agencyInScope(scope, NaN), false);
});

/**
 * De-duplication of agency ids.
 *
 * A real profile was observed with agency_admin = [1, 1] — the login group
 * parser pushed an id per matching CloudTAKAgency* group without de-duping,
 * and a caller could arrive with the same agency listed twice. agencyScope()
 * must collapse duplicates so downstream membership checks and any
 * count-based UI logic (e.g. auto-select-when-single-agency) behave correctly.
 */

test('agencyScope: collapses duplicate agency ids into a single membership', () => {
    const scope = agencyScope([1, 1]);
    assert.equal(agencyInScope(scope, 1), true);
    assert.equal(agencyInScope(scope, 2), false);
    // The internal set must hold one entry, not two.
    assert.equal(scope.all, false);
    if (!scope.all) assert.equal(scope.agencyIds.size, 1);
});

/**
 * Machine-user identity + naming.
 *
 * The connection-delete flow must find and delete exactly the right Authentik
 * service account. It derives the username from the connection's certificate
 * CN (authoritative, survives a rename), falling back to re-deriving from the
 * connection name. isMachineUser() is the guard that stops us ever deleting a
 * human account - it cannot use a `machineUser` attribute because the
 * service_account create endpoint drops custom attributes.
 */

test('machineUsernameFor: agency-owned uses etl-agency{id}- prefix and sanitises', () => {
    assert.equal(machineUsernameFor('Amazon Web Services', 1), 'etl-agency1-amazon-web-services');
});

test('machineUsernameFor: no agency omits the agency segment', () => {
    assert.equal(machineUsernameFor('Amazon Web Services'), 'etl-amazon-web-services');
    assert.equal(machineUsernameFor('Amazon Web Services', null), 'etl-amazon-web-services');
});

test('machineUsernameFor: collapses non-alphanumerics to hyphens, lowercases', () => {
    assert.equal(machineUsernameFor('Foo/Bar 99!', 3), 'etl-agency3-foo-bar-99-');
});

test('machineUsernameFromCertSubject: extracts CN from comma-separated subject', () => {
    assert.equal(
        machineUsernameFromCertSubject('CN=etl-agency1-amazon-web-services, O=TAK, OU=CloudTAK'),
        'etl-agency1-amazon-web-services',
    );
});

test('machineUsernameFromCertSubject: handles CN not first and newline-separated', () => {
    assert.equal(
        machineUsernameFromCertSubject('O=TAK\nCN=etl-foo\nOU=CloudTAK'),
        'etl-foo',
    );
});

test('machineUsernameFromCertSubject: returns undefined when no CN or empty input', () => {
    assert.equal(machineUsernameFromCertSubject('O=TAK, OU=CloudTAK'), undefined);
    assert.equal(machineUsernameFromCertSubject(''), undefined);
    assert.equal(machineUsernameFromCertSubject(undefined), undefined);
    assert.equal(machineUsernameFromCertSubject(null), undefined);
});

test('isMachineUser: true only for service accounts with the etl- username prefix', () => {
    assert.equal(isMachineUser({ type: 'service_account', username: 'etl-agency1-aws' }), true);
    // A human (internal) account, even if named like one, is never a machine user.
    assert.equal(isMachineUser({ type: 'internal', username: 'etl-agency1-aws' }), false);
    // A service account that is not an ETL machine user must not be deleted.
    assert.equal(isMachineUser({ type: 'service_account', username: 'ak-outpost-abc' }), false);
    assert.equal(isMachineUser({ type: 'service_account' }), false);
    assert.equal(isMachineUser({ username: 'etl-agency1-aws' }), false);
});

/**
 * Channel access -> Authentik group name mapping.
 *   duplex -> base tak_<Channel>
 *   read   -> tak_<Channel>_READ
 *   write  -> tak_<Channel>_WRITE
 */

test('channelGroupName: duplex resolves to the base group', () => {
    assert.equal(channelGroupName('tak_', 'Teams - AWS', 'duplex'), 'tak_Teams - AWS');
    // Anything unrecognised also falls back to the base (duplex) group.
    assert.equal(channelGroupName('tak_', 'Teams - AWS', 'whatever'), 'tak_Teams - AWS');
});

test('channelGroupName: read/write resolve to the suffixed variants (case-insensitive)', () => {
    assert.equal(channelGroupName('tak_', 'Teams - AWS', 'read'), 'tak_Teams - AWS_READ');
    assert.equal(channelGroupName('tak_', 'Teams - AWS', 'write'), 'tak_Teams - AWS_WRITE');
    assert.equal(channelGroupName('tak_', 'Teams - AWS', 'READ'), 'tak_Teams - AWS_READ');
    assert.equal(channelGroupName('tak_', 'Teams - AWS', 'Write'), 'tak_Teams - AWS_WRITE');
});
