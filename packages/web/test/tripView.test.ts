import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rangeSelected, selectTrips, toggleSelected } from '../src/tripView.ts';
import type { CardTrip } from '../src/card.ts';

const MINUTE = 60_000;
const trip = (id: string, startLocalMs: number, minutes: number, hasEvent = false): CardTrip => ({
  id, startLocalMs, endLocalMs: startLocalMs + minutes * MINUTE, clips: [], hasEvent,
});

const T = Date.UTC(2026, 7, 4, 12);
const morning = trip('morning', T, 20);
const noon = trip('noon', T + 60 * MINUTE, 5);
const evening = trip('evening', T + 480 * MINUTE, 12);
const drives = [morning, noon, evening];
const events = [trip('bump', T + 200 * MINUTE, 1, true)];

describe('selectTrips', () => {
  test('riskiest puts the lowest score first and unscored trips last', () => {
    const scores: Record<string, number> = { morning: 90, evening: 55 };
    assert.deepEqual(
      selectTrips(drives, events, 'drives', 'riskiest', (t) => scores[t.id]).map((t) => t.id),
      ['evening', 'morning', 'noon'],
    );
  });

  test('defaults to newest first, which is the drive you just took', () => {
    assert.deepEqual(
      selectTrips(drives, events, 'drives', 'newest').map((t) => t.id),
      ['evening', 'noon', 'morning'],
    );
  });

  test('sorts oldest first on request', () => {
    assert.deepEqual(
      selectTrips(drives, events, 'drives', 'oldest').map((t) => t.id),
      ['morning', 'noon', 'evening'],
    );
  });

  test('sorts by duration', () => {
    assert.deepEqual(
      selectTrips(drives, events, 'drives', 'longest').map((t) => t.id),
      ['morning', 'evening', 'noon'],
    );
  });

  test('filters to drives or events', () => {
    assert.deepEqual(selectTrips(drives, events, 'events', 'newest').map((t) => t.id), ['bump']);
    assert.equal(selectTrips(drives, events, 'drives', 'newest').length, 3);
  });

  test('all interleaves both lists in time order', () => {
    assert.deepEqual(
      selectTrips(drives, events, 'all', 'oldest').map((t) => t.id),
      ['morning', 'noon', 'bump', 'evening'],
    );
  });

  test('does not mutate the arrays it was given', () => {
    const original = [...drives];
    selectTrips(drives, events, 'drives', 'oldest');
    assert.deepEqual(drives, original);
  });
});

describe('toggleSelected', () => {
  test('adds then removes, leaving the original untouched', () => {
    const empty = new Set<string>();
    const one = toggleSelected(empty, 'morning');
    assert.deepEqual([...one], ['morning']);
    assert.deepEqual([...empty], []);
    assert.deepEqual([...toggleSelected(one, 'morning')], []);
  });
});

describe('rangeSelected', () => {
  const visible = ['a', 'b', 'c', 'd'];

  test('fills in from the anchor to the clicked row', () => {
    assert.deepEqual([...rangeSelected(new Set(), visible, 'b', 'd')], ['b', 'c', 'd']);
  });

  test('works backwards, and keeps what was already selected', () => {
    const selected = new Set(['a']);
    assert.deepEqual([...rangeSelected(selected, visible, 'd', 'c')].sort(), ['a', 'c', 'd']);
  });

  test('falls back to a plain toggle with no anchor, or one that is filtered out', () => {
    assert.deepEqual([...rangeSelected(new Set(), visible, null, 'c')], ['c']);
    assert.deepEqual([...rangeSelected(new Set(), visible, 'gone', 'c')], ['c']);
  });
});
