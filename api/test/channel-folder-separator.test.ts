import test from 'node:test';
import assert from 'node:assert';
import {
    DEFAULT_CHANNEL_FOLDER_SEPARATOR,
    resolveChannelFolderSeparator,
    stripOneMatchedQuotePair,
} from '../common/channel-folder-separator.js';

const resolve = (value?: string) => resolveChannelFolderSeparator(
    value === undefined ? {} : { CHANNEL_FOLDER_SEPARATOR: value },
);

test('channel folder separator - defaults to " - "', () => {
    assert.equal(DEFAULT_CHANNEL_FOLDER_SEPARATOR, ' - ');
    assert.equal(resolve(), ' - ');
    assert.equal(resolve(''), ' - ');
});

test('channel folder separator - uses a configured value as written', () => {
    assert.equal(resolve(' / '), ' / ');
    assert.equal(resolve(' > '), ' > ');
    assert.equal(resolve('::'), '::');
});

test('channel folder separator - strips one matched pair of quotes and keeps inner spaces', () => {
    assert.equal(resolve('" - "'), ' - ');
    assert.equal(resolve('\' / \''), ' / ');
    assert.equal(resolve('"::"'), '::');
});

test('channel folder separator - strips only one pair', () => {
    assert.equal(resolve('""x""'), '"x"');
});

test('channel folder separator - leaves unmatched or inner quotes alone', () => {
    assert.equal(resolve('" - '), '" - ');
    assert.equal(resolve('\' - "'), '\' - "');
    assert.equal(resolve('a"b'), 'a"b');
});

test('channel folder separator - falls back to the default when nothing visible is left', () => {
    assert.equal(resolve(' '), ' - ');
    assert.equal(resolve('   '), ' - ');
    assert.equal(resolve('" "'), ' - ');
    assert.equal(resolve('""'), ' - ');
});

test('channel folder separator - is not trimmed', () => {
    assert.equal(resolve('  |  '), '  |  ');
});

test('stripOneMatchedQuotePair - short values are unchanged', () => {
    assert.equal(stripOneMatchedQuotePair(''), '');
    assert.equal(stripOneMatchedQuotePair('"'), '"');
    assert.equal(stripOneMatchedQuotePair('x'), 'x');
});
