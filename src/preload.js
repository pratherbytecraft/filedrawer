const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('filedrawer', {
  getState: () => ipcRenderer.invoke('state'),
  onState: on('state'),
  onCommand: on('command'),
  list: (dir, opts) => ipcRenderer.invoke('folder:list', dir, opts),
  resolve: (text, cwd) => ipcRenderer.invoke('folder:resolve', text, cwd),
  complete: (text, cwd) => ipcRenderer.invoke('folder:complete', text, cwd),
  volume: (dir) => ipcRenderer.invoke('folder:volume', dir),
  icons: (reqs, px) => ipcRenderer.invoke('folder:icons', reqs, px),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  open: (p) => ipcRenderer.send('open', p),
  openWindow: (dir) => ipcRenderer.send('window:open', dir),
  setTitle: (name, dir) => ipcRenderer.send('window:title', { name, dir }),
  openPrivacy: () => ipcRenderer.send('privacy:open')
});
