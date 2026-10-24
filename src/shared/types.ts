// What the main process and the pages say to each other: the state the
// pages draw from, the settings, the items in a folder, and every message
// between them. The preload, src/main/ipc.ts and the pages all use these,
// so a message with the wrong name or the wrong payload fails the type check.

// ---------- settings ----------

// The settings file is only checked for the kind of each value (see clean in
// src/main/settings.ts), so the choices written next to a key below are what
// the pages set, not a promise. Only sorts and columns are checked by value.
export type SortKey = 'name' | 'size' | 'kind' | 'modified' | 'created' | 'added' | 'deleted' | 'from' | 'used';
export type ColumnKey = 'size' | 'kind' | 'modified' | 'created' | 'added';
export type SortDir = 'asc' | 'desc';

export interface FolderSort {
  key: SortKey;
  dir: SortDir;
}

// Which places Other Places shows.
export type PlaceKey = 'recents' | 'home' | 'desktop' | 'documents' | 'downloads' | 'applications' | 'icloud' | 'computer' | 'trash';

export interface Settings {
  theme: string; // system | classic-2009 | classic-2001 | classic-1995
  schemes: {
    'classic-2009': string;
    'classic-2001': string;
    'classic-1995': string;
  };
  appearance: string; // auto | light | dark
  accent: string; // auto | blue | purple | pink | red | orange | yellow | green | graphite
  view: string; // thumbs | tiles | icons | list | details
  newWindowView: string; // last | thumbs | tiles | icons | list | details
  startFolder: string; // home | documents | desktop | computer | custom
  startPath: string;
  openFolders: string; // same | new | tab
  clickToOpen: string; // double | single
  showPane: boolean;
  perFolderView: boolean;
  folderViews: Record<string, string>; // folder path -> view
  previews: boolean;
  showExtensions: boolean;
  fullPathTitle: boolean;
  foldersFirst: boolean;
  confirmTrash: boolean;
  terminalButton: boolean;
  hiddenButton: boolean;
  takeOverFinder: boolean;
  welcomed: boolean;
  updates: {
    auto: boolean;
  };
  pane: string; // tasks | folders
  showHidden: boolean;
  pins: string[];
  places: Record<PlaceKey, boolean>;
  terminal: string; // an app's name or path
  openWith: Record<string, string[]>; // extension -> app paths, last picked first
  folderSorts: Record<string, FolderSort>; // folder path -> sort
  folderColumns: Record<string, ColumnKey[]>; // folder path -> Details columns after Name
  columnWidths: Record<string, Record<string, number>>; // kind of list -> column -> points
  window: {
    width: number;
    height: number;
  };
}

// A change to the settings: any keys, and any keys of the ones that hold
// an object. The main process cleans it before it's kept.
export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends unknown[] ? Settings[K] : Settings[K] extends object ? Partial<Settings[K]> : Settings[K];
};

// ---------- folders ----------

// One item in a folder, or in one of the places that aren't a folder.
export interface Item {
  name: string;
  display: string; // the name Finder shows
  path: string;
  dir: boolean;
  package: boolean;
  link: boolean;
  ext: string;
  size: number | null;
  modified: number;
  created: number;
  hidden: boolean;
  kind: string;
  // A Finder alias: where it points, and whether that's a plain folder.
  alias?: string;
  aliasDir?: boolean;
  added?: number; // ms, when it was put in its folder
  fixed?: boolean; // in a folder that can't be changed
  canAdd?: boolean; // a folder things can be pasted or dropped into
  // A disk, in Computer.
  volume?: boolean;
  free?: number | null;
  total?: number | null;
  // In the Trash: where it came from, when it was trashed.
  from?: string | null;
  deleted?: number;
  trashed?: boolean;
  used?: number; // in Recents, ms
  bundle?: string; // an app's folder in iCloud Drive, by its bundle id
}

// Why a folder couldn't be listed. fda is the Trash without Full Disk
// Access, icloud is iCloud Drive switched off.
export type ListError = 'missing' | 'denied' | 'other' | 'fda' | 'icloud';

export type Listing =
  | { path: string; items: Item[]; modified?: number | null; writable?: boolean; error?: undefined }
  | { path: string; error: ListError; items?: undefined };

export interface ListOptions {
  hidden?: boolean;
  extensions?: boolean;
}

// What an address typed into the address bar points at.
export interface Resolved {
  type: 'dir' | 'file' | 'missing';
  path: string;
}

// A folder for the list under the address bar: its path, and the way it's
// written in the bar (with ~ when the text had it).
export interface Completion {
  path: string;
  value: string;
}

export interface VolumeInfo {
  name: string;
  free: number;
}

// An icon asked for by key. A package or a file with no extension gets its
// own icon, any other file its type's.
export interface IconRequest {
  key: string;
  path: string;
  ext: string;
  package?: boolean;
}

// Data URLs by key or path, null where there's no picture.
export type Pictures = Record<string, string | null>;

// ---------- file operations ----------

// What a file operation answers: the path it made or changed, or an error
// for the user.
export interface OpResult {
  path?: string;
  error?: string;
}

// A trashed item: where it was, and where it is in the Trash.
export interface TrashedItem {
  from: string;
  to: string;
}

export interface TrashResult {
  items: TrashedItem[];
  error?: string;
}

// The paths an operation left behind, for the window to select.
export interface Made {
  paths: string[];
}

export type UndoWhich = 'undo' | 'redo';
export type EditCommand = 'cut' | 'copy' | 'paste';

// ---------- windows ----------

// What a folder window shows, for the menus.
export interface WindowLook {
  view: string;
  pane: string;
  cwd: string;
  split: boolean;
  sort: FolderSort;
}

// A menu command for the front window, with its argument (a view, a sort
// key, a folder or a title).
export interface Command {
  command: string;
  arg?: string;
}

export type WatchSlot = 'main' | 'other';

// ---------- search ----------

export interface SearchQuery {
  name: string;
  word: string;
  root: string;
  age: string; // '' | week | month | year
  size: string; // '' | small | medium | large
  hidden: boolean;
  extensions: boolean;
}

export interface SearchResults {
  id: number;
  items: Item[];
}

export interface SearchState {
  id: number;
  state: 'searching' | 'walking' | 'stopped' | 'done';
  count?: number;
  capped?: boolean;
}

// ---------- Properties, Open With and the app list ----------

// An app that can open a file.
export interface AppChoice {
  path: string;
  name: string;
  default: boolean;
  claims: boolean;
  picked?: boolean;
  icon?: string | null;
}

// The app that opens files now, for Properties.
export interface OpensWith {
  path: string | null;
  name: string;
  icon: string | null;
}

export interface PropsData {
  one: boolean;
  name: string;
  volume: { free: number; total: number | null } | null;
  fullName: string;
  kind: string;
  location: string;
  icon: string | null;
  folder: boolean;
  created: number | null;
  modified: number | null;
  accessed: number | null;
  locked: boolean | null;
  hidden: boolean | null;
  hideExt: boolean | null;
  version: string;
  whereFrom: string[];
  comment: string | null;
  opensWith: OpensWith | null;
}

// What Properties changes: the name and the switches.
export interface PropsChange {
  name?: string;
  locked?: boolean;
  hidden?: boolean;
  hideExt?: boolean;
  comment?: string;
}

// The sizes Properties counts in the background.
export interface PropsSize {
  bytes: number;
  disk: number;
  files: number;
  folders: number;
  done: boolean;
}

export type ChooserMode = 'change' | 'choose';
// type: every file like these, file: these files only, open: Choose App...
// without the box ticked.
export type ChooserScope = 'type' | 'file' | 'open';

export interface ChooserData {
  mode: ChooserMode;
  name: string;
  ext: string;
  kind: string;
  icon: string | null;
  apps: AppChoice[];
  order: string[];
}

export interface ChooserChoice {
  app: string;
  scope: ChooserScope;
}

// ---------- copy and move jobs ----------

export type JobChoice = 'replace' | 'keep' | 'skip' | 'cancel';

// A name that's taken: the item, the folder, and how many items are left.
export interface JobQuestion {
  name: string;
  folder: string;
  more: number;
}

export interface JobUpdate {
  title: string;
  line: string;
  current: string;
  fraction: number;
  left: string;
  question: JobQuestion | null;
}

// ---------- the state ----------

export interface SystemLook {
  appearance: 'dark' | 'light';
  accent: string;
}

export interface LoginItem {
  on: boolean;
  needsApproval: boolean;
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'available' | 'failed';
  latest?: string;
}

// A theme and its color schemes, as [id, name] pairs.
export interface Theme {
  id: string;
  name: string;
  schemes: [string, string][];
}

// accessibility is null until the Finder watch has said.
export interface FinderPermission {
  accessibility: boolean | null;
  automation: string; // allowed | denied | ask | unknown
}

export type PhotosStatus = 'allowed' | 'denied' | 'unknown';

export type SiblingKey = 'startbar' | 'shotdrawer';

// A row in the About page's Also from Prather Bytecraft group.
export interface Sibling {
  key: SiblingKey;
  name: string;
  desc: string;
  installed: boolean;
  line: string;
}

export interface State {
  settings: Settings;
  system: SystemLook;
  home: string;
  cut: string[];
  computer: string;
  trash: string;
  recents: string;
  icloud: string;
  icloudOn: boolean;
  user: string;
  version: string;
  loginItem: LoginItem;
  update: UpdateStatus;
  updateCommand: string;
  themes: Theme[];
  finder: FinderPermission;
  photos: PhotosStatus;
  startbar: boolean;
  siblings: Sibling[];
  startFolder: string;
}

// A terminal app Open Terminal Here can use.
export interface TerminalApp {
  name: string;
  path: string;
  icon: string | null;
}

export type LinkKey = 'website' | 'github' | 'community' | 'kofi' | 'issues';
export type SettingsPage = 'general' | 'appearance' | 'folders' | 'terminal' | 'viewer' | 'about';
export type WelcomeChoice = 'continue' | 'close';

// ---------- the messages ----------

// Pages to main, answered: the arguments and the answer.
export interface Invokes {
  state: { args: []; result: State };
  'folder:list': { args: [dir: string, opts?: ListOptions]; result: Listing };
  'folder:resolve': { args: [text: string, cwd: string]; result: Resolved };
  'folder:complete': { args: [text: string, cwd: string]; result: Completion[] };
  'folder:volume': { args: [dir: string]; result: VolumeInfo | null };
  'folder:icons': { args: [reqs: IconRequest[], px: number]; result: Pictures };
  'folder:thumbs': { args: [paths: string[], px: number]; result: Pictures };
  'folder:count': { args: [dir: string, cwd: string]; result: number | null };
  'folder:place': { args: [dir: string]; result: string | null };
  'trash:putBack': { args: [paths: string[]]; result: Made };
  'trash:delete': { args: [paths: string[]]; result: OpResult };
  'op:rename': { args: [from: string, name: string]; result: OpResult };
  // True to keep the old extension.
  'ask:extension': { args: [was: string, now: string]; result: boolean };
  'op:newFolder': { args: [dir: string]; result: OpResult };
  'op:newText': { args: [dir: string]; result: OpResult };
  'op:trash': { args: [paths: string[]]; result: TrashResult };
  'op:undo': { args: [which: UndoWhich]; result: void };
  'clip:copy': { args: [paths: string[]]; result: void };
  'clip:cut': { args: [paths: string[]]; result: void };
  'clip:paste': { args: [dest: string]; result: Made };
  'op:drop': { args: [paths: string[], dest: string, copy: boolean]; result: Made };
  'send:zip': { args: [paths: string[]]; result: OpResult };
  'send:desktop': { args: [paths: string[]]; result: OpResult };
  'send:copy': { args: [paths: string[], dest: string]; result: Made };
  'op:moveTo': { args: [paths: string[], dest: string]; result: Made };
  'op:eject': { args: [volume: string]; result: OpResult };
  'op:duplicate': { args: [paths: string[]]; result: Made };
  'op:alias': { args: [paths: string[]]; result: Made };
  'openWith:apps': { args: [p: string]; result: AppChoice[] };
  'props:get': { args: []; result: PropsData | null };
  'props:apply': { args: [change: PropsChange]; result: OpResult };
  'chooser:get': { args: []; result: ChooserData | null };
  'chooser:browse': { args: []; result: AppChoice | null };
  'chooser:done': { args: [choice: ChooserChoice]; result: { error?: string } };
  'settings:update': { args: [patch: SettingsPatch]; result: Settings };
  'settings:terminals': { args: []; result: TerminalApp[] };
  // A window standing in for a Finder window waits here for its folder.
  'window:waitFolder': { args: []; result: string | null };
}

// Pages to main, one way: the arguments.
export interface Sends {
  'folder:watch': [dir: string | null, slot?: WatchSlot];
  'window:view': [look: WindowLook];
  'trash:open': [];
  'trash:empty': [];
  'privacy:fda': [];
  'terminal:open': [dir: string];
  'search:start': [id: number, q: SearchQuery];
  'search:stop': [];
  'edit:text': [which: EditCommand];
  'drag:start': [paths: string[]];
  'send:mail': [paths: string[]];
  'clip:path': [paths: string[]];
  'props:open': [paths: string[]];
  'openWith:open': [appPath: string, paths: string[]];
  'openWith:choose': [paths: string[]];
  // A path, or nothing to close the preview.
  quicklook: [p: string | null | undefined];
  'props:changeApp': [];
  'props:fit': [height: number];
  // id is the job's, as its window's address has it.
  'job:answer': [id: string, choice: JobChoice, all: boolean];
  'job:cancel': [id: string];
  // One path, or several that open together.
  open: [p: string | string[]];
  'window:open': [dir: string];
  'window:title': [title: { name: string; dir: string }];
  'window:drawn': [];
  'privacy:open': [];
  'settings:open': [page?: SettingsPage];
  'settings:login': [on: boolean];
  'updates:check': [];
  'clipboard:text': [text: string];
  'settings:export': [];
  'settings:import': [];
  'settings:reset': [];
  'settings:startFolder': [];
  'settings:terminal': [];
  link: [name: LinkKey];
  'sibling:open': [key: SiblingKey];
  'finder:accessibility': [];
  'finder:automation': [];
  'photos:ask': [];
  'photos:refresh': [];
  welcome: [what: WelcomeChoice];
}

// Main to pages: the payload.
export interface Events {
  state: State;
  command: Command;
  'folder:changed': string;
  'search:results': SearchResults;
  'search:state': SearchState;
  // True while a drag that started in a Filedrawer window is going on.
  'drag:own': boolean;
  'props:size': PropsSize;
  'props:opensWith': OpensWith | null;
  'job:update': JobUpdate;
  'settings:page': SettingsPage;
}

type Listen<T> = (fn: (payload: T) => void) => () => void;

// window.filedrawer, given to the pages by the preload.
export interface FiledrawerApi {
  getState(): Promise<State>;
  onState: Listen<State>;
  onCommand: Listen<Command>;
  onFolderChanged: Listen<string>;
  watch(dir: string | null, slot?: WatchSlot): void;
  list(dir: string, opts?: ListOptions): Promise<Listing>;
  resolve(text: string, cwd: string): Promise<Resolved>;
  complete(text: string, cwd: string): Promise<Completion[]>;
  volume(dir: string): Promise<VolumeInfo | null>;
  icons(reqs: IconRequest[], px: number): Promise<Pictures>;
  thumbs(paths: string[], px: number): Promise<Pictures>;
  setView(look: WindowLook): void;
  count(dir: string, cwd: string): Promise<number | null>;
  openTrash(): void;
  emptyTrash(): void;
  putBack(paths: string[]): Promise<Made>;
  deleteNow(paths: string[]): Promise<OpResult>;
  openFullDiskAccess(): void;
  placeOf(dir: string): Promise<string | null>;
  openTerminal(dir: string): void;
  startSearch(id: number, q: SearchQuery): void;
  stopSearch(): void;
  onSearchResults: Listen<SearchResults>;
  onSearchState: Listen<SearchState>;
  rename(from: string, name: string): Promise<OpResult>;
  // True to keep the old extension.
  askExtension(was: string, now: string): Promise<boolean>;
  newFolder(dir: string): Promise<OpResult>;
  newText(dir: string): Promise<OpResult>;
  trash(paths: string[]): Promise<TrashResult>;
  undo(which: UndoWhich): Promise<void>;
  editText(which: EditCommand): void;
  copyFiles(paths: string[]): Promise<void>;
  cutFiles(paths: string[]): Promise<void>;
  paste(dest: string): Promise<Made>;
  startDrag(paths: string[]): void;
  // copy forces a copy, otherwise items move on the same disk and copy to another.
  drop(paths: string[], dest: string, copy: boolean): Promise<Made>;
  onDragOwn: Listen<boolean>;
  sendToZip(paths: string[]): Promise<OpResult>;
  sendToDesktop(paths: string[]): Promise<OpResult>;
  sendToMail(paths: string[]): void;
  sendToFolder(paths: string[], dest: string): Promise<Made>;
  moveTo(paths: string[], dest: string): Promise<Made>;
  eject(volume: string): Promise<OpResult>;
  duplicate(paths: string[]): Promise<Made>;
  makeAlias(paths: string[]): Promise<Made>;
  copyPath(paths: string[]): void;
  showProps(paths: string[]): void;
  openWithApps(p: string): Promise<AppChoice[]>;
  openWith(appPath: string, paths: string[]): void;
  chooseApp(paths: string[]): void;
  quickLook(p: string | null | undefined): void;
  // The Properties window.
  getProps(): Promise<PropsData | null>;
  onPropsSize: Listen<PropsSize>;
  applyProps(change: PropsChange): Promise<OpResult>;
  changeDefaultApp(): void;
  fitProps(height: number): void;
  onPropsOpensWith: Listen<OpensWith | null>;
  // The app list window behind Change... and Choose App...
  chooserGet(): Promise<ChooserData | null>;
  chooserBrowse(): Promise<AppChoice | null>;
  chooserDone(choice: ChooserChoice): Promise<{ error?: string }>;
  // The progress window of a copy or move.
  onJob: Listen<JobUpdate>;
  answerJob(id: string, choice: JobChoice, all: boolean): void;
  cancelJob(id: string): void;
  // The path of a file dropped from Finder or another app.
  pathForFile(file: File): string;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  // One path, or several that open together (pictures share one Preview window).
  open(p: string | string[]): void;
  openWindow(dir: string): void;
  setTitle(name: string, dir: string): void;
  // A window standing in for a Finder window waits here for its folder.
  waitFolder(): Promise<string | null>;
  // The page has drawn once in the theme's colors.
  drawn(): void;
  openPrivacy(): void;
  // The settings window.
  openSettings(page?: SettingsPage): void;
  onSettingsPage: Listen<SettingsPage>;
  terminals(): Promise<TerminalApp[]>;
  setLoginItem(on: boolean): void;
  checkUpdates(): void;
  copyText(text: string): void;
  exportSettings(): void;
  importSettings(): void;
  resetSettings(): void;
  chooseStartFolder(): void;
  chooseTerminal(): void;
  openLink(name: LinkKey): void;
  openSibling(key: SiblingKey): void;
  // The Default File Manager page's permission buttons.
  finderAccessibility(): void;
  finderAutomation(): void;
  // The Photos row on the General page.
  photosAsk(): void;
  photosRefresh(): void;
  // The first launch note.
  welcome(what: WelcomeChoice): void;
}
