import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocal, formatAbsolute, toAbsolute, describeCameraDrift } from '../src/time.ts';

/**
 * The reference card was recorded in Massachusetts by a camera still set to
 * UTC-8, so its stamped 13:33 is really 17:33 Eastern.
 */
const CAMERA_OFFSET = -8 * 3_600_000;
const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };

// startLocalMs encodes the camera's naive local reading through Date.UTC.
const stamped = Date.UTC(2026, 7, 4, 13, 33, 33);

describe('formatLocal', () => {
  test('shows the camera clock exactly as recorded', () => {
    const context = { zone: 'camera' as const, cameraUtcOffsetMs: CAMERA_OFFSET };
    assert.equal(formatLocal(stamped, context, CLOCK), '13:33');
  });

  test('re-renders a camera reading in a chosen zone', () => {
    const context = { zone: 'America/New_York', cameraUtcOffsetMs: CAMERA_OFFSET };
    // 13:33 on a UTC-8 clock is 21:33 UTC, which is 17:33 Eastern in August.
    assert.equal(formatLocal(stamped, context, CLOCK), '17:33');
  });

  test('agrees with the camera when its clock happens to be right', () => {
    const context = { zone: 'America/New_York', cameraUtcOffsetMs: -4 * 3_600_000 };
    assert.equal(formatLocal(stamped, context, CLOCK), '13:33');
  });

  // Without the offset there is nothing honest to convert, so the raw clock is
  // shown rather than a plausible-looking wrong time.
  test('falls back to the raw reading when the offset is unknown', () => {
    const context = { zone: 'America/New_York', cameraUtcOffsetMs: undefined };
    assert.equal(formatLocal(stamped, context, CLOCK), '13:33');
  });

  test('UTC is a selectable zone', () => {
    const context = { zone: 'UTC', cameraUtcOffsetMs: CAMERA_OFFSET };
    assert.equal(formatLocal(stamped, context, CLOCK), '21:33');
  });
});

describe('formatAbsolute', () => {
  // GPS timestamps are already absolute instants.
  const instant = Date.UTC(2026, 7, 4, 21, 33, 33);

  test('renders a GPS instant in the chosen zone', () => {
    assert.equal(
      formatAbsolute(instant, { zone: 'America/New_York', cameraUtcOffsetMs: CAMERA_OFFSET }, CLOCK),
      '17:33',
    );
  });

  test('renders a GPS instant back on the camera clock', () => {
    assert.equal(
      formatAbsolute(instant, { zone: 'camera', cameraUtcOffsetMs: CAMERA_OFFSET }, CLOCK),
      '13:33',
    );
  });

  test('round-trips against formatLocal', () => {
    for (const zone of ['camera', 'UTC', 'America/New_York', 'Australia/Sydney']) {
      const context = { zone, cameraUtcOffsetMs: CAMERA_OFFSET };
      assert.equal(
        formatAbsolute(toAbsolute(stamped, context)!, context, CLOCK),
        formatLocal(stamped, context, CLOCK),
        `zone ${zone}`,
      );
    }
  });
});

describe('describeCameraDrift', () => {
  test('names the offset the camera is running on', () => {
    assert.equal(describeCameraDrift(CAMERA_OFFSET), 'Camera clock is UTC-8');
    assert.equal(describeCameraDrift(0), 'Camera clock is UTC+0');
    assert.equal(describeCameraDrift(5.5 * 3_600_000), 'Camera clock is UTC+5:30');
  });

  test('says nothing when the offset was never measured', () => {
    assert.equal(describeCameraDrift(undefined), null);
  });
});
