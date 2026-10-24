// What every page gets from the preload, and the shared types under the
// names the pages use. The pages are plain scripts that share globals, so
// these are global too.
import type * as T from '../shared/types';

declare global {
  interface Window {
    filedrawer: T.FiledrawerApi;
    applyTheme(state: T.State): void;
  }
  type State = T.State;
  type JobChoice = T.JobChoice;
  type AppChoice = T.AppChoice;
  type ChooserData = T.ChooserData;
  type ChooserScope = T.ChooserScope;
  type PropsData = T.PropsData;
  type PropsChange = T.PropsChange;
  type OpensWith = T.OpensWith;
  type SettingsPatch = T.SettingsPatch;
  type TerminalApp = T.TerminalApp;
  type FinderPermission = T.FinderPermission;
  type UpdateStatus = T.UpdateStatus;
  type Sibling = T.Sibling;
  type LinkKey = T.LinkKey;
  type Settings = T.Settings;
  type Item = T.Item;
  type ListError = T.ListError;
  type SortKey = T.SortKey;
  type ColumnKey = T.ColumnKey;
  type FolderSort = T.FolderSort;
  type PlaceKey = T.PlaceKey;
  type IconRequest = T.IconRequest;
  type Completion = T.Completion;
  type SearchQuery = T.SearchQuery;
  type SearchState = T.SearchState;
  type UndoWhich = T.UndoWhich;
  type EditCommand = T.EditCommand;
  type WindowLook = T.WindowLook;
  type Listing = T.Listing;

  // The pages keep their timers in variables that start as null, and the
  // browser takes null here and does nothing.
  function clearTimeout(id: number | null): void;
  function cancelAnimationFrame(handle: number | null): void;
}

export {};
