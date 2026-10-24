// ipcMain and webContents.send with the messages in shared/types.ts, so a
// handler gets the arguments its page sends and a page gets the payload it
// listens for.
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { Events, Invokes, Sends } from '../shared/types';

type Answer<K extends keyof Invokes> = Invokes[K]['result'] | Promise<Invokes[K]['result']>;

export function handle<K extends keyof Invokes>(channel: K, fn: (e: IpcMainInvokeEvent, ...args: Invokes[K]['args']) => Answer<K>) {
  ipcMain.handle(channel, (e, ...args) => fn(e, ...(args as Invokes[K]['args'])));
}

export function on<K extends keyof Sends>(channel: K, fn: (e: IpcMainEvent, ...args: Sends[K]) => void) {
  ipcMain.on(channel, (e, ...args) => fn(e, ...(args as Sends[K])));
}

// An event with no payload takes no argument.
export type Payload<K extends keyof Events> = Events[K] extends void ? [] : [payload: Events[K]];

export function send<K extends keyof Events>(to: WebContents, channel: K, ...payload: Payload<K>) {
  to.send(channel, ...payload);
}
