import { useCallback, useEffect, useState } from 'react';

/**
 * How recorded times are displayed.
 *
 * `camera` shows the clock the camera itself stamped, which is what the
 * filenames and the burned-in overlay use. That clock is frequently wrong --
 * the reference card was recorded in Massachusetts by a camera still set to
 * UTC-8 -- so any IANA zone can be substituted, and the absolute instant from
 * the GPS receiver is re-rendered in it.
 */
export type TimeZoneSetting = 'camera' | 'browser' | string;

const STORAGE_KEY = 'wolfbox.timezone';

/** Offered in the picker. `camera` and `browser` are handled specially. */
export const TIME_ZONES: { value: TimeZoneSetting; label: string }[] = [
  { value: 'camera', label: 'Camera clock (as recorded)' },
  { value: 'browser', label: 'This computer' },
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Arizona (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Berlin', label: 'Central Europe (Berlin)' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];

export function useTimeZoneSetting(): [TimeZoneSetting, (next: TimeZoneSetting) => void] {
  const [zone, setZone] = useState<TimeZoneSetting>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? 'camera';
    } catch {
      return 'camera'; // Private windows and blocked storage must not break the app.
    }
  });

  const update = useCallback((next: TimeZoneSetting) => {
    setZone(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* not essential */ }
  }, []);

  return [zone, update];
}

/**
 * Resolves the display context once, so every formatter agrees.
 *
 * `cameraUtcOffsetMs` is how far the camera's own clock sits from real time,
 * measured from a clip's telemetry. It is what lets a filename timestamp -- a
 * naive local reading with no zone attached -- be placed on the real timeline.
 */
export interface TimeContext {
  zone: TimeZoneSetting;
  cameraUtcOffsetMs: number | undefined;
}

/** Converts the camera's naive local reading into an absolute instant. */
export function toAbsolute(localMs: number, context: TimeContext): number | undefined {
  if (context.cameraUtcOffsetMs === undefined) return undefined;
  return localMs - context.cameraUtcOffsetMs;
}

function resolvedZone(zone: TimeZoneSetting): string | undefined {
  if (zone === 'browser') return undefined; // Intl default is the host zone.
  return zone;
}

/**
 * Formats a camera-local reading (a filename timestamp, or `startLocalMs`).
 *
 * With the camera clock selected the value is rendered as-is. Otherwise it is
 * lifted onto the real timeline and re-rendered, which needs the camera offset;
 * without it there is nothing honest to convert, so the raw clock is shown.
 */
export function formatLocal(
  localMs: number,
  context: TimeContext,
  options: Intl.DateTimeFormatOptions,
): string {
  if (context.zone === 'camera') {
    // startLocalMs encodes a naive local reading via Date.UTC, so reading it
    // back in UTC returns exactly the digits the camera stamped.
    return new Intl.DateTimeFormat([], { ...options, timeZone: 'UTC' }).format(localMs);
  }
  const absolute = toAbsolute(localMs, context);
  if (absolute === undefined) {
    return new Intl.DateTimeFormat([], { ...options, timeZone: 'UTC' }).format(localMs);
  }
  return new Intl.DateTimeFormat([], { ...options, timeZone: resolvedZone(context.zone) })
    .format(absolute);
}

/** Formats an absolute instant from the GPS receiver. */
export function formatAbsolute(
  absoluteMs: number,
  context: TimeContext,
  options: Intl.DateTimeFormatOptions,
): string {
  if (context.zone === 'camera') {
    const localMs = context.cameraUtcOffsetMs === undefined
      ? absoluteMs
      : absoluteMs + context.cameraUtcOffsetMs;
    return new Intl.DateTimeFormat([], { ...options, timeZone: 'UTC' }).format(localMs);
  }
  return new Intl.DateTimeFormat([], { ...options, timeZone: resolvedZone(context.zone) })
    .format(absoluteMs);
}

/** Human-readable summary of the camera's clock error, or null when it is right. */
export function describeCameraDrift(cameraUtcOffsetMs: number | undefined): string | null {
  if (cameraUtcOffsetMs === undefined) return null;
  const hours = cameraUtcOffsetMs / 3_600_000;
  const sign = hours < 0 ? '-' : '+';
  const abs = Math.abs(hours);
  const whole = Math.floor(abs);
  const minutes = Math.round((abs - whole) * 60);
  return `Camera clock is UTC${sign}${whole}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/** Re-render when the host time zone changes (rare, but cheap to support). */
export function useHostZone(): string {
  const [zone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  useEffect(() => { /* host zone changes require a reload; nothing to subscribe to */ }, []);
  return zone;
}
