// What the Mac looks like right now: light or dark, and the accent color.
// The System theme follows both. Changes are pushed to every window.
import { nativeTheme, systemPreferences } from 'electron';
import type { SystemLook } from '../shared/types';

const listeners = new Set<(look: SystemLook) => void>();

function accentHex() {
  try {
    const raw = systemPreferences.getAccentColor(); // RRGGBBAA on macOS
    if (raw && raw.length >= 6) return '#' + raw.slice(0, 6);
  } catch {
    // older macOS or no accent set
  }
  return nativeTheme.shouldUseDarkColors ? '#0a84ff' : '#007aff';
}

export function snapshot(): SystemLook {
  return {
    appearance: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    accent: accentHex()
  };
}

function emit() {
  const s = snapshot();
  for (const fn of listeners) fn(s);
}

export function watch(fn: (look: SystemLook) => void) {
  listeners.add(fn);
  if (listeners.size === 1) {
    nativeTheme.on('updated', emit);
    try {
      systemPreferences.subscribeNotification('AppleColorPreferencesChangedNotification', emit);
      systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', emit);
    } catch {
      // not fatal, nativeTheme still covers light and dark
    }
  }
  return () => listeners.delete(fn);
}

