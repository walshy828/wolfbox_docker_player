import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePinned, ALL_PINNED } from '../src/panels.ts';

describe('parsePinned', () => {
  test('nothing stored leaves both panels pinned', () => {
    assert.deepEqual(parsePinned(null), ALL_PINNED);
    assert.deepEqual(parsePinned(''), ALL_PINNED);
  });

  test('reads a stored setting back', () => {
    assert.deepEqual(
      parsePinned('{"trips":false,"map":true}'),
      { trips: false, map: true },
    );
  });

  test('a side written by another build falls back to pinned', () => {
    assert.deepEqual(parsePinned('{"map":false}'), { trips: true, map: false });
    assert.deepEqual(parsePinned('{"trips":"yes","map":1}'), ALL_PINNED);
  });

  test('damaged storage never hides a panel', () => {
    assert.deepEqual(parsePinned('not json'), ALL_PINNED);
    assert.deepEqual(parsePinned('null'), ALL_PINNED);
    assert.deepEqual(parsePinned('[false,false]'), ALL_PINNED);
  });
});
