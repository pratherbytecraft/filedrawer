# Filedrawer

A file manager for macOS, laid out like the classic file windows: a toolbar with Back, Forward and Up, a text address bar you can type a path into, a pane on the left with your pinned folders and places, and Thumbnails, Tiles, Icons, List and Details views. It opens in place of Finder's folder windows. Free to use.

![Filedrawer in the System theme](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/window-system.png)

## Install

```
npm install -g filedrawer
filedrawer
```

Or with Homebrew.

```
brew install pratherbytecraft/tap/filedrawer
filedrawer
```

`filedrawer ~/Documents` opens a window at that folder.

Filedrawer needs Node 18 or newer and Apple's Command Line Tools, which the install uses to build a small helper for file icons. If they're missing, the install says so; run `xcode-select --install`, then `npm rebuild -g filedrawer`.

The install also adds Filedrawer to the Applications folder in your home folder, so you can open it again from Spotlight or the Dock.

## Uninstall

```
npm uninstall -g filedrawer
```

Or `brew uninstall filedrawer` if you installed it with Homebrew. Then move Filedrawer from the Applications folder in your home folder to the Trash.

## What it does

Each window has tabs, in a strip under the title bar. Command T opens a new tab, Command W closes one, Control Tab moves between them, and a folder's right click or a middle click opens it in a new tab. Each tab keeps its own folder, history and view.

Two Panes on the toolbar, or Option Command P, splits a tab into two sides, each with its own folder. Click a side or press Tab to work in it. Drag items from one side to the other, or use Copy to Other Side (F5) and Move to Other Side (F6).

![Two panes, Documents and Downloads](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/two-panes.png)

Type a path into the address bar and press Return, and it fills in folder names as you type. Back and Forward each keep a list of where you've been, and Up goes to the folder above. The arrow at the end of the address bar lists the folders above this one and your pinned folders.

The left pane shows your pinned folders, other places and the details of the selection. Everything you can do to a file or folder is on its right click, and the right click of empty space has New Folder, Pin This Folder, Open in New Window and Open Terminal Here. The Folders button swaps it for a folder tree. Drop a folder on Pinned to pin it, or right click a folder and pick Pin to Pinned.

Open Terminal Here is on the toolbar, the File menu and the right click menus, and opens the folder in Terminal or the terminal app you pick in Settings. Hidden Files on the toolbar shows and hides hidden files, the same as Show Hidden Files on the View menu. When the window is too narrow for every button, the ones that don't fit move into a More button at the end of the toolbar.

Copy, cut and paste work with Finder both ways, and cut and paste moves files. Drag items between windows, to other apps and to Finder, and drop them on folders in the list, the tree or the pane. A picture or video dropped from Photos lands as its edited version, the way Finder gets it, once the Photos permission is allowed on the General page in Settings. Pictures come out as JPEG. Without the permission, a picture lands as its original file and a video can't be dropped. There's room below the last item in every view, so a selection box can start there. Opening several files at once opens them together, so pictures share one Preview window. Rename with F2 or a slow second click on a name. Duplicate, Make Alias and Copy Path are on the right click and the menus. Move to Trash, Undo and Redo cover renaming, new items, copies and moves. Space shows a file in Quick Look, and Open With lists the apps that can open it.

Properties shows sizes, dates, where a download came from and comments, and can lock an item or hide it or its extension. It also shows the app a file opens with. Change... picks another app for every file with that extension, or for that file only.

![Properties with the Opens with row](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/properties.png)

The Search button finds files by name, by a word inside them, by date or by size, in this folder, your home folder or every disk.

Computer lists your disks with their size and free space, and ejects them.

The Trash shows where each item came from and when it was deleted. Put Back moves items to where they were, and Delete Immediately removes them for good. Recents lists the files you opened in the last 30 days, newest first, and iCloud Drive opens here too.

![The Trash with Original Location and Date Deleted](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/trash.png)

## Themes

The System theme follows your Mac's light or dark setting and your accent color. Classic 2009, Classic 2001 and Classic 1995 are in Settings if you want a retro look, each with its own color schemes.

![Classic 2001](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/window-classic-2001.png)

![Classic 2009](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/window-classic-2009.png)

![Classic 1995 with the folder tree](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/window-classic-1995.png)

## Settings

Open Filedrawer Settings from the Filedrawer menu or with Command comma. Folder Options sets whether folders open in the same window, a new window or a new tab, single or double click to open, the left pane, a view per folder, hidden files, file extensions and which places Other Places shows. Settings also has open at login, the update check, and export, import and reset.

![Filedrawer Settings](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/settings.png)

## In place of Finder

When a folder opens in Finder, from the Dock, the Desktop, Finder itself or `open` in Terminal, Filedrawer opens a window in the same spot and Finder's window closes. Show in Finder from other apps opens Filedrawer too, with the item picked.

Filedrawer opens at login so this works from the start, without opening a window. Folder windows Finder reopens at login are closed, so nothing opens on its own. On its first launch Filedrawer asks for the two permissions this needs. Accessibility lets it see when Finder opens a window, and Control Finder lets it ask which folder that window shows.

Finder keeps the Desktop, Get Info windows, AirDrop and Network. The Trash moves over too once Filedrawer has Full Disk Access. Hold Option while opening a folder to open it in Finder instead.

The Default File Manager page in Settings turns this off and shows any permission that's still missing. Filedrawer has to be running for it to work, so it opens when you log in while this is on. If you use an app that quits other apps after their last window closes, add Filedrawer to that app's exceptions.

![The Default File Manager page](https://raw.githubusercontent.com/pratherbytecraft/filedrawer/main/docs/screenshots/default-file-manager.png)

## Folder access

macOS asks before Filedrawer opens your Desktop, Documents and Downloads folders for the first time. If you said no, Filedrawer shows a button that opens Privacy & Security, where you can switch it on under Files and Folders.

The Trash needs Full Disk Access, since macOS keeps the Trash private from other apps. Open the Trash in Filedrawer and it shows a button to Privacy & Security. Switch on Filedrawer under Full Disk Access, then pick Quit & Reopen when macOS asks.

## Updates

Filedrawer checks for a newer version now and then and shows it on the General page. It never installs anything by itself. To update, run `npm install -g filedrawer` again, or `brew upgrade filedrawer` if you installed it with Homebrew, then quit Filedrawer and open it. The General page shows the line that fits your copy, with a Copy button.

## Help

Open an issue at https://github.com/pratherbytecraft/filedrawer/issues.

## License

Copyright 2026 Prather Bytecraft. All rights reserved. Filedrawer is free to install and use, and its source code can be read, but it can't be copied, changed or shared. See LICENSE.
