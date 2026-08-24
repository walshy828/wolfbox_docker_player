import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorForMph, colorForBand, bandIndexForMph, rampGradient,
  SPEED_BANDS, STOPPED_BAND, TOP_SPEED_MPH, type Theme,
} from '../src/speedScale.ts';

/** sRGB relative luminance, for the monotonicity check. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('speed ramp', () => {
  for (const theme of ['light', 'dark'] as Theme[]) {
    // This is the property that keeps the ramp readable for colour-blind
    // viewers: lightness alone must encode speed.
    test(`${theme}: lightness falls monotonically as speed rises`, () => {
      let previous = Infinity;
      for (let mph = 1; mph <= TOP_SPEED_MPH; mph++) {
        const current = luminance(colorForMph(mph, theme));
        assert.ok(current <= previous + 1e-6,
          `luminance rose at ${mph} mph (${current} > ${previous})`);
        previous = current;
      }
    });

    test(`${theme}: the ramp spans a wide lightness range`, () => {
      const slow = luminance(colorForMph(1, theme));
      const fast = luminance(colorForMph(TOP_SPEED_MPH, theme));
      assert.ok(slow / fast > 3, `range was only ${(slow / fast).toFixed(1)}x`);
    });

    test(`${theme}: colours are distinguishable across each band boundary`, () => {
      for (const band of SPEED_BANDS) {
        if (band.maxMph === Infinity) continue;
        const below = colorForMph(band.maxMph - 1, theme);
        const above = colorForMph(Math.min(band.maxMph + 10, TOP_SPEED_MPH), theme);
        assert.notEqual(below, above, `band ending at ${band.maxMph} does not change`);
      }
    });
  }

  test('dark steps clear 3:1 against the dark surface', () => {
    for (let mph = 1; mph <= TOP_SPEED_MPH; mph++) {
      const ratio = contrast(colorForMph(mph, 'dark'), '#1a1a19');
      assert.ok(ratio >= 3, `${mph} mph is only ${ratio.toFixed(2)}:1`);
    }
  });

  test('blends rather than stepping between bands', () => {
    // Adjacent speeds inside a band must differ, or the line would look banded.
    const samples = [20, 21, 22, 40, 41, 42, 70, 71, 72].map((mph) => colorForMph(mph, 'light'));
    assert.equal(new Set(samples).size, samples.length);
  });

  test('pins the top colour at and above the threshold', () => {
    const top = colorForMph(TOP_SPEED_MPH, 'light');
    assert.equal(colorForMph(95, 'light'), top);
    assert.equal(colorForMph(300, 'light'), top);
  });

  test('the top of the ramp is a deep red-purple', () => {
    const top = colorForMph(TOP_SPEED_MPH, 'light');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(top.slice(i, i + 2), 16)) as [number, number, number];
    assert.ok(r > g && b > g, `expected red and blue over green, got ${top}`);
    assert.ok(luminance(top) < 0.12, `expected a dark colour, got ${top}`);
  });

  test('stopped is neutral and outside the ramp', () => {
    const stopped = colorForMph(0, 'light');
    assert.equal(stopped, colorForBand(STOPPED_BAND, 'light'));
    assert.notEqual(stopped, colorForMph(1, 'light'));
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(stopped.slice(i, i + 2), 16)) as [number, number, number];
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 12, 'stopped should read as grey');
  });

  test('band lookup aligns with the histogram buckets', () => {
    assert.equal(bandIndexForMph(0), -1);
    assert.equal(bandIndexForMph(10), 0);
    assert.equal(bandIndexForMph(20), 1);
    assert.equal(bandIndexForMph(40), 2);
    assert.equal(bandIndexForMph(70), 3);
    assert.equal(bandIndexForMph(100), 4);
  });

  test('non-finite speeds fall back to stopped instead of throwing', () => {
    assert.equal(colorForMph(Number.NaN, 'light'), colorForMph(0, 'light'));
  });

  test('the legend gradient covers the ramp', () => {
    const gradient = rampGradient('light');
    assert.match(gradient, /^linear-gradient\(to right, #/);
    assert.ok(gradient.includes(colorForMph(TOP_SPEED_MPH, 'light')));
  });
});
