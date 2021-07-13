import EventEmitter from "events";
import * as nodeWindows from "node-window-manager";
import { BFGame } from "./ServerInterface";
export function wait(delay:number):Promise<void> {
    return new Promise(function (resolve) {
        setTimeout(resolve, delay);
    });
}
export function waitForEvent(emitter:EventEmitter, eventName:string):any {
    return new Promise((res) => {
        emitter.once(eventName, res);
    });
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