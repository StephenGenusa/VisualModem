import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings, SCREEN_DEFAULTS, FILE_DEFAULTS } from '../web/settings.js';

test('unsupported levels fall back to the default', () => {
  assert.equal(sanitizeSettings('screen', { levels: 3 }).levels, SCREEN_DEFAULTS.levels);
  assert.equal(sanitizeSettings('file', { levels: 3 }).levels, FILE_DEFAULTS.levels);
  assert.equal(sanitizeSettings('screen', { levels: 8 }).levels, 8);
});
test('file block size is clamped to the readable range', () => {
  assert.equal(sanitizeSettings('file', { blockSize: 8 }).blockSize, 4);
  assert.equal(sanitizeSettings('file', { blockSize: 0 }).blockSize, 1);
  assert.equal(sanitizeSettings('file', { blockSize: 3 }).blockSize, 3);
});
test('screen block size has a floor of 4', () => {
  assert.equal(sanitizeSettings('screen', { blockSize: 2 }).blockSize, 4);
  assert.equal(sanitizeSettings('screen', { blockSize: 20 }).blockSize, 20);
});
test('non numbers fall back to the default', () => {
  assert.equal(sanitizeSettings('screen', { fps: '' }).fps, SCREEN_DEFAULTS.fps);
  assert.equal(sanitizeSettings('screen', { fps: null }).fps, SCREEN_DEFAULTS.fps);
  assert.equal(sanitizeSettings('screen', { parity: NaN }).parity, SCREEN_DEFAULTS.parity);
  assert.deepEqual(sanitizeSettings('screen', null), SCREEN_DEFAULTS);
  assert.deepEqual(sanitizeSettings('file', 'junk'), FILE_DEFAULTS);
});
test('fps is clamped to 0.5 .. 10 in 0.5 steps', () => {
  assert.equal(sanitizeSettings('screen', { fps: 0.1 }).fps, 0.5);
  assert.equal(sanitizeSettings('screen', { fps: 30 }).fps, 10);
  assert.equal(sanitizeSettings('screen', { fps: 2.7 }).fps, 2.5);
});
test('parity is an even integer from 0 to 128', () => {
  assert.equal(sanitizeSettings('screen', { parity: 33 }).parity, 32);
  assert.equal(sanitizeSettings('screen', { parity: 200 }).parity, 128);
  assert.equal(sanitizeSettings('screen', { parity: -4 }).parity, 0);
});
test('file width and height are integers from the smallest grid to 8192', () => {
  const s = sanitizeSettings('file', { blockSize: 4, width: 10, height: 99999 });
  assert.equal(s.width, 33 * 4);
  assert.equal(s.height, 8192);
  assert.equal(sanitizeSettings('file', { width: 1000.7 }).width, 1000);
});
test('unknown keys are dropped', () => {
  assert.deepEqual(Object.keys(sanitizeSettings('screen', { extra: 1 })).sort(), Object.keys(SCREEN_DEFAULTS).sort());
});
test('white level defaults to 255 and is clamped to 64 .. 255', () => {
  assert.equal(SCREEN_DEFAULTS.white, 255);
  assert.equal(sanitizeSettings('screen', {}).white, 255);
  assert.equal(sanitizeSettings('screen', { white: 10 }).white, 64);
  assert.equal(sanitizeSettings('screen', { white: 300 }).white, 255);
  assert.equal(sanitizeSettings('screen', { white: 180.6 }).white, 181);
  assert.equal(sanitizeSettings('screen', { white: 'x' }).white, 255);
  assert.equal(sanitizeSettings('file', { white: 100 }).white, undefined); // files are always full white
});
test('scheme defaults to cube and unknown ids fall back', () => {
  assert.equal(SCREEN_DEFAULTS.scheme, 'cube');
  assert.equal(sanitizeSettings('screen', {}).scheme, 'cube');
  assert.equal(sanitizeSettings('screen', { scheme: 'gray4' }).scheme, 'gray4');
  assert.equal(sanitizeSettings('screen', { scheme: 'plaid' }).scheme, 'cube');
  assert.equal(sanitizeSettings('file', { scheme: 'gray4' }).scheme, undefined);
});
test('fountain coding is on by default and is remembered', () => {
  assert.equal(SCREEN_DEFAULTS.fountain, true);
  assert.equal(sanitizeSettings('screen', {}).fountain, true);
  assert.equal(sanitizeSettings('screen', { fountain: false }).fountain, false);
  assert.equal(sanitizeSettings('screen', { fountain: 'no' }).fountain, true);
  assert.equal(sanitizeSettings('screen', { fountain: 0 }).fountain, true);
  assert.equal(sanitizeSettings('file', { fountain: false }).fountain, undefined);
});
