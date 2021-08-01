import EventEmitter from "events";
import * as nodeWindows from "node-window-manager";
import { BFGame } from "./ServerInterface";
export function wait(delay:number):Promise<void> {
    return new Promise(function (resolve) {
        setTimeout(resolve, delay);
    });
}
export function waitForEvent(emitter:EventEmitter, eventName:string, timeout?:number):any {
    const eventPromise = new Promise((res) => {
        emitter.once(eventName, res);
    });
    if (!timeout) return eventPromise;
    return Promise.race([eventPromise, wait(timeout)]);
}
export function isGameOpen(gameToCheck:BFGame):boolean {
    return(!!getBFWindow(gameToCheck));
}
export function getBFWindow(game:BFGame):nodeWindows.Window | null {
    const gameTitle = (game === "BF4") ? "Battlefield 4" : "Battlefield™ 1";
    return findWindowByName(gameTitle) || null;
}
export function findWindowByName(targetTitle:string):nodeWindows.Window | null {
    let targetWindow:nodeWindows.Window | null = null;
    const windows:Array<nodeWindows.Window> = nodeWindows.windowManager.getWindows();
    for (const window of windows) {
        if (window.getTitle() === targetTitle) {
            targetWindow = window;
            break;
        }
    }
    return targetWindow;
}
export class Logger {
    public readonly moduleName:string;
    constructor(moduleName:string) {
        this.moduleName = moduleName;
    }
    public log = (message:string):void => {
        const logDate = new Date();
        const logPrefix = `[${logDate.toLocaleDateString()} | ${logDate.toLocaleTimeString()}]: [${this.moduleName}] `;
        const lines = message.split("\n");
        for (const line of lines) {
            console.log(logPrefix + line);
        }
    }
}