import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraAspect } from '../web/rxstatus.js';

test('the camera box keeps the stream shape, 16:9 when unknown', () => {
  assert.equal(cameraAspect(1920, 1080), 1920 / 1080);
  assert.equal(cameraAspect(1440, 1080), 4 / 3);
  assert.equal(cameraAspect(1080, 1920), 1080 / 1920);
  assert.equal(cameraAspect(0, 0), 16 / 9);
  assert.equal(cameraAspect(undefined, 1080), 16 / 9);
});
