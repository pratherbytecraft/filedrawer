// The first launch note: ask, then a row per permission ticked off as each
// is allowed, then all set. The permissions come with the app's state.
const api = window.filedrawer;
const $ = (id) => document.getElementById(id);
let step = 'ask'; // ask | wait | done
let app = null;

function row(ok, name, text, id, label) {
  return `<div class="row"><span class="check${ok ? ' ok' : ''}">${ok ? '&#10003;' : ''}</span>`
    + `<div class="lbl">${name}<small>${text}</small></div>`
    + (ok || !id ? '' : `<div class="ctl"><span class="btn primary" id="${id}">${label}</span></div>`) + '</div>';
}

function draw() {
  if (!app) return;
  const appearance = app.settings.appearance !== 'auto' && app.settings.theme === 'system' ? app.settings.appearance : app.system.appearance;
  document.documentElement.dataset.appearance = appearance;
  const p = app.finder || {};
  const ax = !!p.accessibility;
  const ae = p.automation === 'allowed';
  if (step === 'wait' && ax && ae) step = 'done';
  if (step === 'ask') {
    $('text').innerHTML = '<h3>Open folders in Filedrawer?</h3>'
      + '<p>Filedrawer can open in place of Finder\'s folder windows, so folders from the Dock, the Desktop and other apps open here.</p>'
      + '<p>macOS needs two permissions for that. Accessibility lets Filedrawer see when Finder opens a window. Control Finder lets it ask which folder that window shows.</p>';
    $('steps').hidden = true;
    $('btns').innerHTML = '<span class="btn" id="later">Not Now</span><span class="btn primary" id="go">Continue</span>';
  } else if (step === 'wait') {
    $('text').innerHTML = '<h3>Two permissions to allow</h3>'
      + '<p>System Settings is open at Accessibility. Turn on Filedrawer in the list, then come back here.</p>';
    $('steps').hidden = false;
    $('steps').innerHTML = row(ax, 'Accessibility', ax ? 'Allowed.' : 'Turn on Filedrawer in the Accessibility list.', 'ax', 'Open Privacy Settings')
      + row(ae, 'Control Finder', ae ? 'Allowed.' : p.automation === 'denied' ? 'Turned off in Privacy and Security, Automation.' : 'macOS asks once. Pick Allow.',
        'ae', p.automation === 'denied' ? 'Open Privacy Settings' : 'Allow');
    $('btns').innerHTML = '<span class="btn" id="later">Not Now</span>';
  } else {
    $('text').innerHTML = '<h3>All set</h3>'
      + '<p>Folders now open in Filedrawer. Hold Option while opening one to use Finder instead. You can turn this off on the Default File Manager page in Settings.</p>';
    $('steps').hidden = false;
    $('steps').innerHTML = row(true, 'Accessibility', 'Allowed.') + row(true, 'Control Finder', 'Allowed.');
    $('btns').innerHTML = '<span class="btn primary" id="done">Done</span>';
  }
}

document.addEventListener('click', (e) => {
  switch (e.target.id) {
    case 'go':
      step = 'wait';
      api.welcome('continue');
      draw();
      break;
    case 'later':
    case 'done':
      api.welcome('close');
      break;
    case 'ax':
      api.finderAccessibility();
      break;
    case 'ae':
      api.finderAutomation();
      break;
  }
});

api.onState((state) => {
  app = state;
  draw();
});
api.getState().then((state) => {
  app = state;
  draw();
});
