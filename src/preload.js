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
  openTerminal: (dir) => ipcRenderer.send('terminal:open', dir),
  rename: (from, name) => ipcRenderer.invoke('op:rename', from, name),
  newFolder: (dir) => ipcRenderer.invoke('op:newFolder', dir),
  newText: (dir) => ipcRenderer.invoke('op:newText', dir),
  trash: (paths) => ipcRenderer.invoke('op:trash', paths),
  undo: (which) => ipcRenderer.invoke('op:undo', which),
  editText: (which) => ipcRenderer.send('edit:text', which),
  copyFiles: (paths) => ipcRenderer.invoke('clip:copy', paths),
  cutFiles: (paths) => ipcRenderer.invoke('clip:cut', paths),
  paste: (dest) => ipcRenderer.invoke('clip:paste', dest),
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
  openPrivacy: () => ipcRenderer.send('privacy:open')
});
