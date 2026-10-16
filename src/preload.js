const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('filedrawer', {
  getState: () => ipcRenderer.invoke('state'),
  onState: on('state'),
  onCommand: on('command'),
  onFolderChanged: on('folder:changed'),
  watch: (dir) => ipcRenderer.send('folder:watch', dir),
  list: (dir, opts) => ipcRenderer.invoke('folder:list', dir, opts),
  resolve: (text, cwd) => ipcRenderer.invoke('folder:resolve', text, cwd),
  complete: (text, cwd) => ipcRenderer.invoke('folder:complete', text, cwd),
  volume: (dir) => ipcRenderer.invoke('folder:volume', dir),
  icons: (reqs, px) => ipcRenderer.invoke('folder:icons', reqs, px),
  thumbs: (paths, px) => ipcRenderer.invoke('folder:thumbs', paths, px),
  setView: (look) => ipcRenderer.send('window:view', look),
  count: (dir, cwd) => ipcRenderer.invoke('folder:count', dir, cwd),
  openTrash: () => ipcRenderer.send('trash:open'),
  emptyTrash: () => ipcRenderer.send('trash:empty'),
  putBack: (paths) => ipcRenderer.invoke('trash:putBack', paths),
  deleteNow: (paths) => ipcRenderer.invoke('trash:delete', paths),
  openFullDiskAccess: () => ipcRenderer.send('privacy:fda'),
  placeOf: (dir) => ipcRenderer.invoke('folder:place', dir),
  openTerminal: (dir) => ipcRenderer.send('terminal:open', dir),
  startSearch: (id, q) => ipcRenderer.send('search:start', id, q),
  stopSearch: () => ipcRenderer.send('search:stop'),
  onSearchResults: on('search:results'),
  onSearchState: on('search:state'),
  rename: (from, name) => ipcRenderer.invoke('op:rename', from, name),
  // True to keep the old extension.
  askExtension: (was, now) => ipcRenderer.invoke('ask:extension', was, now),
  newFolder: (dir) => ipcRenderer.invoke('op:newFolder', dir),
  newText: (dir) => ipcRenderer.invoke('op:newText', dir),
  trash: (paths) => ipcRenderer.invoke('op:trash', paths),
  undo: (which) => ipcRenderer.invoke('op:undo', which),
  editText: (which) => ipcRenderer.send('edit:text', which),
  copyFiles: (paths) => ipcRenderer.invoke('clip:copy', paths),
  cutFiles: (paths) => ipcRenderer.invoke('clip:cut', paths),
  paste: (dest) => ipcRenderer.invoke('clip:paste', dest),
  startDrag: (paths) => ipcRenderer.send('drag:start', paths),
  // copy forces a copy, otherwise items move on the same disk and copy to another.
  drop: (paths, dest, copy) => ipcRenderer.invoke('op:drop', paths, dest, copy),
  sendToZip: (paths) => ipcRenderer.invoke('send:zip', paths),
  sendToDesktop: (paths) => ipcRenderer.invoke('send:desktop', paths),
  sendToMail: (paths) => ipcRenderer.send('send:mail', paths),
  sendToFolder: (paths, dest) => ipcRenderer.invoke('send:copy', paths, dest),
  eject: (volume) => ipcRenderer.invoke('op:eject', volume),
  duplicate: (paths) => ipcRenderer.invoke('op:duplicate', paths),
  makeAlias: (paths) => ipcRenderer.invoke('op:alias', paths),
  copyPath: (paths) => ipcRenderer.send('clip:path', paths),
  showProps: (paths) => ipcRenderer.send('props:open', paths),
  openWithApps: (p) => ipcRenderer.invoke('openWith:apps', p),
  openWith: (appPath, paths) => ipcRenderer.send('openWith:open', appPath, paths),
  chooseApp: (paths) => ipcRenderer.send('openWith:choose', paths),
  quickLook: (p) => ipcRenderer.send('quicklook', p),
  // The Properties window.
  getProps: () => ipcRenderer.invoke('props:get'),
  onPropsSize: on('props:size'),
  applyProps: (change) => ipcRenderer.invoke('props:apply', change),
  changeDefaultApp: () => ipcRenderer.send('props:changeApp'),
  fitProps: (height) => ipcRenderer.send('props:fit', height),
  onPropsOpensWith: on('props:opensWith'),
  // The app list window behind Change... and Choose App...
  chooserGet: () => ipcRenderer.invoke('chooser:get'),
  chooserBrowse: () => ipcRenderer.invoke('chooser:browse'),
  chooserDone: (choice) => ipcRenderer.invoke('chooser:done', choice),
  // The progress window of a copy or move.
  onJob: on('job:update'),
  answerJob: (id, choice, all) => ipcRenderer.send('job:answer', id, choice, all),
  cancelJob: (id) => ipcRenderer.send('job:cancel', id),
  // The path of a file dropped from Finder or another app.
  pathForFile: (file) => webUtils.getPathForFile(file),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  open: (p) => ipcRenderer.send('open', p),
  openWindow: (dir) => ipcRenderer.send('window:open', dir),
  setTitle: (name, dir) => ipcRenderer.send('window:title', { name, dir }),
  // A window standing in for a Finder window waits here for its folder.
  waitFolder: () => ipcRenderer.invoke('window:waitFolder'),
  // The page has drawn once in the theme's colors.
  drawn: () => ipcRenderer.send('window:drawn'),
  openPrivacy: () => ipcRenderer.send('privacy:open'),
  // The settings window.
  openSettings: (page) => ipcRenderer.send('settings:open', page),
  onSettingsPage: on('settings:page'),
  terminals: () => ipcRenderer.invoke('settings:terminals'),
  setLoginItem: (on) => ipcRenderer.send('settings:login', on),
  checkUpdates: () => ipcRenderer.send('updates:check'),
  exportSettings: () => ipcRenderer.send('settings:export'),
  importSettings: () => ipcRenderer.send('settings:import'),
  resetSettings: () => ipcRenderer.send('settings:reset'),
  chooseStartFolder: () => ipcRenderer.send('settings:startFolder'),
  chooseTerminal: () => ipcRenderer.send('settings:terminal'),
  openLink: (name) => ipcRenderer.send('link', name),
  // The Default File Manager page's permission buttons.
  finderAccessibility: () => ipcRenderer.send('finder:accessibility'),
  finderAutomation: () => ipcRenderer.send('finder:automation'),
  // The first launch note.
  welcome: (what) => ipcRenderer.send('welcome', what)
});
