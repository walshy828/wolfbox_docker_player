import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaxspeed, limitForWay, inferRegion } from '../src/maxspeed.ts';
import { mphToKph } from '../src/geo.ts';

const near = (actual: number | undefined, expected: number, what: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 0.01,
    `${what}: expected ~${expected}, got ${actual}`);

describe('parseMaxspeed', () => {
  test('a bare number is kilometres per hour', () => {
    const limit = parseMaxspeed('50')!;
    near(limit.kph, 50, 'bare 50');
    assert.equal(limit.source, 'tagged');
  });

  test('an mph tag converts, however it is spaced', () => {
    for (const tag of ['30 mph', '30mph', '30 MPH']) {
      near(parseMaxspeed(tag)?.kph, mphToKph(30), tag);
    }
  });

  test('an explicit metric unit is not converted twice', () => {
    for (const tag of ['50 km/h', '50kmh', '50 kph']) near(parseMaxspeed(tag)?.kph, 50, tag);
  });

  test('an unlimited road has no limit to exceed', () => {
    assert.equal(parseMaxspeed('none')?.kph, Infinity);
  });

  test('a limit set by gantry is unknown, not guessed', () => {
    assert.equal(parseMaxspeed('signals'), null);
    assert.equal(parseMaxspeed('variable'), null);
  });

  test('an implicit country code resolves, and is not called signed', () => {
    const limit = parseMaxspeed('GB:motorway')!;
    near(limit.kph, mphToKph(70), 'GB:motorway');
    assert.equal(limit.source, 'implicit');
  });

  test('a zone tag names its own figure', () => {
    assert.equal(parseMaxspeed('DE:zone30')?.kph, 30);
  });

  test('the first value of a multi-value tag wins', () => {
    near(parseMaxspeed('30;50')?.kph, 30, '30;50');
  });

  test('an unparseable value yields null rather than NaN', () => {
    for (const tag of ['', '  ', 'fast', 'RU:something', '-20', '0']) {
      assert.equal(parseMaxspeed(tag), null, `expected null for ${JSON.stringify(tag)}`);
    }
    assert.equal(parseMaxspeed(undefined), null);
  });
});

describe('limitForWay', () => {
  test('a signed limit beats the road-class fallback', () => {
    const limit = limitForWay({ highway: 'residential', maxspeed: '20 mph' }, 'US')!;
    near(limit.kph, mphToKph(20), 'signed residential');
    assert.equal(limit.source, 'tagged');
  });

  test('an untagged way falls back to its class and says so', () => {
    const limit = limitForWay({ highway: 'residential' }, 'US')!;
    near(limit.kph, mphToKph(25), 'US residential');
    assert.equal(limit.source, 'inferred');
    assert.match(limit.reason, /assumed/);
  });

  test('the same road class is worth different things in different countries', () => {
    const us = limitForWay({ highway: 'residential' }, 'US')!;
    const gb = limitForWay({ highway: 'residential' }, 'GB')!;
    assert.ok(gb.kph > us.kph, 'a British residential street is 30, an American one 25');
  });

  test('an advisory limit never becomes the enforced limit', () => {
    // A slip road plated at 25 advisory is not a 25 limit; without a real tag
    // the class fallback must be what applies.
    const limit = limitForWay(
      { highway: 'motorway_link', 'maxspeed:advisory': '25 mph' }, 'US')!;
    assert.equal(limit.source, 'inferred');
    assert.ok(limit.kph > mphToKph(25), 'advisory plate did not become the limit');
  });

  test('a directional tag applies only in the direction travelled', () => {
    const tags = { highway: 'primary', 'maxspeed:forward': '50', 'maxspeed:backward': '70' };
    near(limitForWay(tags, 'EU', true)?.kph, 50, 'forward');
    near(limitForWay(tags, 'EU', false)?.kph, 70, 'backward');
  });

  test('a link road inherits its parent class, not the top of the table', () => {
    const link = limitForWay({ highway: 'motorway_link' }, 'EU')!;
    const motorway = limitForWay({ highway: 'motorway' }, 'EU')!;
    assert.ok(link.kph < motorway.kph, 'a slip road is not worth a motorway');
  });

  test('a way that is not a road at all has no limit', () => {
    assert.equal(limitForWay({ highway: 'proposed' }, 'US'), null);
    assert.equal(limitForWay({}, 'US'), null);
  });
});

describe('inferRegion', () => {
  test('an explicit country code settles it outright', () => {
    assert.equal(inferRegion([{ 'maxspeed:type': 'GB:national' }]), 'GB');
    assert.equal(inferRegion([{ maxspeed: 'DE:urban' }]), 'EU');
  });

  test('metric tagging reads as metric', () => {
    assert.equal(inferRegion([{ maxspeed: '50' }, { maxspeed: '80' }]), 'EU');
  });

  test('position separates the two countries that both sign in mph', () => {
    const mphTags = [{ maxspeed: '30 mph' }, { maxspeed: '40 mph' }];
    assert.equal(inferRegion(mphTags, { latitude: 51.5, longitude: -0.12 }), 'GB');
    assert.equal(inferRegion(mphTags, { latitude: 42.3, longitude: -71.5 }), 'US');
  });

  test('untagged roads still place the trip by where it happened', () => {
    assert.equal(inferRegion([{ highway: 'residential' }], { latitude: 42.3, longitude: -71.5 }), 'US');
  });

  test('a trip nowhere recognised falls back rather than picking a country', () => {
    assert.equal(inferRegion([], { latitude: -33.9, longitude: 151.2 }), 'DEFAULT');
  });
});
