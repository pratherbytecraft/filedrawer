# Filedrawer

A file manager for macOS, laid out like the classic file windows: a toolbar with Back, Forward and Up, a text address bar you can type a path into, and a list of the folder's files. Free to use.

## Install

```
npm install -g filedrawer
filedrawer
```

`filedrawer ~/Documents` opens a window at that folder.

Filedrawer needs Node 18 or newer and Apple's Command Line Tools, which the install uses to build a small helper for file icons. If they're missing, the install says so; run `xcode-select --install`, then `npm rebuild -g filedrawer`.

The install also adds Filedrawer to the Applications folder in your home folder, so you can open it again from Spotlight or the Dock.

## Folder access

macOS asks before Filedrawer opens your Desktop, Documents and Downloads folders for the first time. If you said no, Filedrawer shows a button that opens Privacy & Security, where you can switch it on under Files and Folders.

## Uninstall

```
npm uninstall -g filedrawer
```

Then move `~/Applications/Filedrawer.app` to the Trash.

## Questions and bugs

Open an issue on [GitHub](https://github.com/pratherbytecraft/filedrawer/issues).

## License

Free to install and use. All rights reserved, see [LICENSE](LICENSE).
