// What the Mac looks like right now: light or dark, and the accent color.
// The System theme follows both. Changes are pushed to every window.
const { nativeTheme, systemPreferences } = require('electron');

const listeners = new Set();

function accentHex() {
  try {
    const raw = systemPreferences.getAccentColor(); // RRGGBBAA on macOS
    if (raw && raw.length >= 6) return '#' + raw.slice(0, 6);
  } catch {
    // older macOS or no accent set
  }
  return nativeTheme.shouldUseDarkColors ? '#0a84ff' : '#007aff';
}

function snapshot() {
  return {
    appearance: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    accent: accentHex()
  };
}

function emit() {
  const s = snapshot();
  for (const fn of listeners) fn(s);
}

function watch(fn) {
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

module.exports = { snapshot, watch };
