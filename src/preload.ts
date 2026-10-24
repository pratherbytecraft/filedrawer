import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { Events, FiledrawerApi, Invokes, Sends } from './shared/types';

const on = <K extends keyof Events>(channel: K) => (fn: (payload: Events[K]) => void) => {
  const handler = (_e: IpcRendererEvent, payload: Events[K]) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const send = <K extends keyof Sends>(channel: K, ...args: Sends[K]) => ipcRenderer.send(channel, ...args);
const invoke = <K extends keyof Invokes>(channel: K, ...args: Invokes[K]['args']): Promise<Invokes[K]['result']> => ipcRenderer.invoke(channel, ...args);

const api: FiledrawerApi = {
  getState: () => invoke('state'),
  onState: on('state'),
  onCommand: on('command'),
  onFolderChanged: on('folder:changed'),
  watch: (dir, slot) => send('folder:watch', dir, slot),
  list: (dir, opts) => invoke('folder:list', dir, opts),
  resolve: (text, cwd) => invoke('folder:resolve', text, cwd),
  complete: (text, cwd) => invoke('folder:complete', text, cwd),
  volume: (dir) => invoke('folder:volume', dir),
  icons: (reqs, px) => invoke('folder:icons', reqs, px),
  thumbs: (paths, px) => invoke('folder:thumbs', paths, px),
  setView: (look) => send('window:view', look),
  count: (dir, cwd) => invoke('folder:count', dir, cwd),
  openTrash: () => send('trash:open'),
  emptyTrash: () => send('trash:empty'),
  putBack: (paths) => invoke('trash:putBack', paths),
  deleteNow: (paths) => invoke('trash:delete', paths),
  openFullDiskAccess: () => send('privacy:fda'),
  placeOf: (dir) => invoke('folder:place', dir),
  openTerminal: (dir) => send('terminal:open', dir),
  startSearch: (id, q) => send('search:start', id, q),
  stopSearch: () => send('search:stop'),
  onSearchResults: on('search:results'),
  onSearchState: on('search:state'),
  rename: (from, name) => invoke('op:rename', from, name),
  // True to keep the old extension.
  askExtension: (was, now) => invoke('ask:extension', was, now),
  newFolder: (dir) => invoke('op:newFolder', dir),
  newText: (dir) => invoke('op:newText', dir),
  trash: (paths) => invoke('op:trash', paths),
  undo: (which) => invoke('op:undo', which),
  editText: (which) => send('edit:text', which),
  copyFiles: (paths) => invoke('clip:copy', paths),
  cutFiles: (paths) => invoke('clip:cut', paths),
  paste: (dest) => invoke('clip:paste', dest),
  startDrag: (paths) => send('drag:start', paths),
  // copy forces a copy, otherwise items move on the same disk and copy to another.
  drop: (paths, dest, copy) => invoke('op:drop', paths, dest, copy),
  // true while a drag that started in a Filedrawer window is going on.
  onDragOwn: on('drag:own'),
  sendToZip: (paths) => invoke('send:zip', paths),
  sendToDesktop: (paths) => invoke('send:desktop', paths),
  sendToMail: (paths) => send('send:mail', paths),
  sendToFolder: (paths, dest) => invoke('send:copy', paths, dest),
  moveTo: (paths, dest) => invoke('op:moveTo', paths, dest),
  eject: (volume) => invoke('op:eject', volume),
  duplicate: (paths) => invoke('op:duplicate', paths),
  makeAlias: (paths) => invoke('op:alias', paths),
  copyPath: (paths) => send('clip:path', paths),
  showProps: (paths) => send('props:open', paths),
  openWithApps: (p) => invoke('openWith:apps', p),
  openWith: (appPath, paths) => send('openWith:open', appPath, paths),
  chooseApp: (paths) => send('openWith:choose', paths),
  quickLook: (p) => send('quicklook', p),
  // The Properties window.
  getProps: () => invoke('props:get'),
  onPropsSize: on('props:size'),
  applyProps: (change) => invoke('props:apply', change),
  changeDefaultApp: () => send('props:changeApp'),
  fitProps: (height) => send('props:fit', height),
  onPropsOpensWith: on('props:opensWith'),
  // The app list window behind Change... and Choose App...
  chooserGet: () => invoke('chooser:get'),
  chooserBrowse: () => invoke('chooser:browse'),
  chooserDone: (choice) => invoke('chooser:done', choice),
  // The progress window of a copy or move.
  onJob: on('job:update'),
  answerJob: (id, choice, all) => send('job:answer', id, choice, all),
  cancelJob: (id) => send('job:cancel', id),
  // The path of a file dropped from Finder or another app.
  pathForFile: (file) => webUtils.getPathForFile(file),
  updateSettings: (patch) => invoke('settings:update', patch),
  // One path, or several that open together (pictures share one Preview window).
  open: (p) => send('open', p),
  openWindow: (dir) => send('window:open', dir),
  setTitle: (name, dir) => send('window:title', { name, dir }),
  // A window standing in for a Finder window waits here for its folder.
  waitFolder: () => invoke('window:waitFolder'),
  // The page has drawn once in the theme's colors.
  drawn: () => send('window:drawn'),
  openPrivacy: () => send('privacy:open'),
  // The settings window.
  openSettings: (page) => send('settings:open', page),
  onSettingsPage: on('settings:page'),
  terminals: () => invoke('settings:terminals'),
  setLoginItem: (on) => send('settings:login', on),
  checkUpdates: () => send('updates:check'),
  copyText: (text) => send('clipboard:text', text),
  exportSettings: () => send('settings:export'),
  importSettings: () => send('settings:import'),
  resetSettings: () => send('settings:reset'),
  chooseStartFolder: () => send('settings:startFolder'),
  chooseTerminal: () => send('settings:terminal'),
  openLink: (name) => send('link', name),
  openSibling: (key) => send('sibling:open', key),
  // The Default File Manager page's permission buttons.
  finderAccessibility: () => send('finder:accessibility'),
  finderAutomation: () => send('finder:automation'),
  // The Photos row on the General page: ask for the permission, and look
  // again at its state (after a trip to Privacy Settings).
  photosAsk: () => send('photos:ask'),
  photosRefresh: () => send('photos:refresh'),
  // The first launch note.
  welcome: (what) => send('welcome', what)
};

contextBridge.exposeInMainWorld('filedrawer', api);
