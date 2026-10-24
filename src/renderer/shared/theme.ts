// Applies settings and the Mac's current look to the document: which theme
// stylesheet is loaded, light or dark, and the accent color.
(function () {
  const ACCENTS: Record<string, [string, string]> = {
    blue: ['#007aff', '#0a84ff'],
    purple: ['#af52de', '#bf5af2'],
    pink: ['#ff2d55', '#ff375f'],
    red: ['#ff3b30', '#ff453a'],
    orange: ['#ff9500', '#ff9f0a'],
    yellow: ['#ffcc00', '#ffd60a'],
    green: ['#34c759', '#30d158'],
    graphite: ['#8e8e93', '#98989d']
  };

  function luminance(hex: string) {
    const n = parseInt(hex.slice(1, 7), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  // Light or dark and the accent color after the settings' "Follow Mac"
  // choices are filled in from the Mac.
  function resolve(state: State) {
    const { settings, system } = state;
    const appearance = settings.appearance === 'auto' ? system.appearance : settings.appearance;
    const dark = appearance === 'dark';
    const accent = settings.accent === 'auto' ? system.accent : (ACCENTS[settings.accent] || ACCENTS.blue)[dark ? 1 : 0];
    return { appearance, accent, accentText: luminance(accent) > 0.7 ? '#1d1d1f' : '#ffffff' };
  }

  function apply(state: State) {
    const { settings } = state;
    const root = document.documentElement;
    const { appearance, accent, accentText } = resolve(state);
    root.dataset.theme = settings.theme;
    root.dataset.scheme = (settings.schemes && (settings.schemes as Record<string, string>)[settings.theme]) || '';
    root.dataset.appearance = appearance;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-text', accentText);
    // Small windows (a job's progress) carry their own styles for each theme.
    const link = document.getElementById('theme-css');
    const href = `../themes/${settings.theme}.css`;
    if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
  }

  window.applyTheme = apply;
})();
