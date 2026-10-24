// Electron's dialogs take a null window and then show the dialog on its
// own, not as a sheet, but its types only list a window or no window at
// all. Filedrawer passes BrowserWindow.fromWebContents() as it comes, which
// is null for a page that has no window anymore.
declare namespace Electron {
  interface Dialog {
    showMessageBox(window: BaseWindow | null, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
    showOpenDialog(window: BaseWindow | null, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
    showSaveDialog(window: BaseWindow | null, options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  }
}
