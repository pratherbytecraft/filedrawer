# Filedrawer

A file manager for macOS, laid out like the classic file windows: a toolbar with Back, Forward and Up, a text address bar you can type a path into, a task pane on the left, and Thumbnails, Tiles, Icons, List and Details views. Free to use.

![Filedrawer in the System theme](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/window-system.png)

## Install

```
npm install -g filedrawer
filedrawer
```

`filedrawer ~/Documents` opens a window at that folder.

Filedrawer needs Node 18 or newer and Apple's Command Line Tools, which the install uses to build a small helper for file icons. If they're missing, the install says so; run `xcode-select --install`, then `npm rebuild -g filedrawer`.

The install also adds Filedrawer to the Applications folder in your home folder, so you can open it again from Spotlight or the Dock.

## Uninstall

```
npm uninstall -g filedrawer
```

Then move Filedrawer from the Applications folder in your home folder to the Trash.

## What it does

Type a path into the address bar and press Return, and it fills in folder names as you type. Back and Forward each keep a list of where you've been, and Up goes to the folder above. The arrow at the end of the address bar lists the folders above this one and your pinned folders.

The left pane shows tasks for what's selected, your pinned folders, other places and the details of the selection. The Folders button swaps it for a folder tree. Drop a folder on Pinned to pin it, or right click a folder and pick Pin to Pinned.

Open Terminal Here is on the toolbar, the File menu and the right click menus, and opens the folder in Terminal or the terminal app you pick in Settings.

Copy, cut and paste work with Finder both ways, and cut and paste moves files. Drag items between windows, to other apps and to Finder, and drop them on folders in the list, the tree or the pane. Rename with F2 or a slow second click on a name. Move to Trash, Undo and Redo cover renaming, new items, copies and moves. Properties shows sizes and dates and can lock or hide an item. Space shows a file in Quick Look, and Open With lists the apps that can open it.

The Search button finds files by name, by a word inside them, by date or by size, in this folder, your home folder or every disk.

Computer lists your disks with their size and free space, and ejects them.

## Themes

The System theme follows your Mac's light or dark setting and your accent color. Classic 2009, Classic 2001 and Classic 1995 are in Settings if you want a retro look, each with its own color schemes.

![Classic 2001](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/window-classic-2001.png)

![Classic 2009](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/window-classic-2009.png)

![Classic 1995 with the folder tree](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/window-classic-1995.png)

## Settings

Open Filedrawer Settings from the Filedrawer menu or with Command comma. Folder Options sets whether folders open in the same window or a new one, single or double click to open, the left pane, a view per folder, hidden files and file extensions. Settings also has open at login, the update check, and export, import and reset.

![Filedrawer Settings](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/settings.png)

## Show in Finder

The Default Viewer page in Settings can make Filedrawer the app other apps use for Show in Finder, so the item opens picked in a Filedrawer window. The same button hands it back to Finder.

macOS keeps the Desktop, the Dock's folders, Finder's own windows and folders opened with `open` in Terminal for Finder, so those still open in Finder.

## Folder access

macOS asks before Filedrawer opens your Desktop, Documents and Downloads folders for the first time. If you said no, Filedrawer shows a button that opens Privacy & Security, where you can switch it on under Files and Folders.

The Trash opens in Finder, since macOS keeps the Trash's list to Finder.

## Updates

Filedrawer checks for a newer version now and then and shows it on the General page. It never installs anything by itself. To update, run `npm install -g filedrawer` again, then quit Filedrawer and open it.

## Help

Open an issue at https://github.com/pratherbytecraft/filedrawer/issues.

## License

Copyright 2026 Prather Bytecraft. All rights reserved. Filedrawer is free to install and use, and its source code can be read, but it can't be copied, changed or shared. See LICENSE.
