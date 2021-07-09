import child_process from "child_process";
import EventEmitter from "events";
import fetch from "node-fetch";
import * as nodeWindows from "node-window-manager";
import * as robot from "robotjs";
import winreg from "winreg";
import * as util from "./util";
import { BFGame, ServerData } from "./ServerInterface";
import { GameState } from "./OriginInterface";
export default class BFController extends EventEmitter {
    private game: BFGame;
    private currentState:GameState = GameState.IDLE;
    private currentTarget:ServerData = {
        "name":null,
        "guid":null,
        "user":"System",
        "timestamp":new Date().getTime(),
    }
    private bfWindow: nodeWindows.Window | null = null;
    private bfPath!: string;
    private refreshInfoTimer: number | null = null;
    private launchTimer: ReturnType<typeof setTimeout> | null = null;
    private firstAntiIdle = true;
    // Target
    get target():ServerData {
        return this.currentTarget;
    }
    set target(newTarget: ServerData) {
        if ((this.currentTarget.guid === newTarget.guid)) return;
        this.currentTarget = newTarget;
        if (!newTarget.guid) {
            this.leaveServer();
        } else {
            this.joinServerById(newTarget.guid);
        }
    }
    // State
    get state():GameState {
        return this.currentState;
    }
    set state(newState:GameState) {
        if (newState === this.state) return;
        this.firstAntiIdle = true;
        const oldState = this.currentState;
        this.currentState = newState;
        this.emit("newState", oldState);
        // Once game launches, set a timer to restart the connection process.
        // If the new state isn't joining, clear the failsafe timeout.
        if (this.launchTimer) {
            clearTimeout(this.launchTimer);
            this.launchTimer = null;
        }
        if (newState === GameState.LAUNCHING) {
            if (this.launchTimer) {
                clearTimeout(this.launchTimer);
                this.launchTimer = null;
            }
            this.launchTimer = setTimeout(() => {
                if (!this.currentTarget.guid) return;
                this.joinServerById(this.currentTarget.guid);
            }, 60000);
        }
        // Detect unintentional disconnects & rejoin.
        if (this.currentTarget.guid && (newState === GameState.DISCONNECTED)) {
            this.joinServerById(this.currentTarget.guid);
            return;
        }
    }
    constructor(currentGame: BFGame) {
        super();
        this.game = currentGame;
        this.init();
    }
    public checkGame():void {
        this.getbfWindow();
        if ((!this.bfWindow) && (this.state !== GameState.LAUNCHING)) {
            this.state = (this.currentTarget.guid === null) ? GameState.IDLE : GameState.DISCONNECTED;
            return;
        }
    }
    private getbfWindow() {
        let bfWindow:nodeWindows.Window | null = null;
        const windows:Array<nodeWindows.Window> = nodeWindows.windowManager.getWindows();
        const gameTitle = (this.game === "BF4") ? "Battlefield 4" : "Battlefield™ 1";
        for (const window of windows) {
            if (window.getTitle() === gameTitle) {
                bfWindow = window;
                break;
            }
        }
        this.bfWindow = bfWindow;
    }
    public antiIdle = (async () => {
        if (this.currentState !== GameState.ACTIVE) return;
        if (!this.bfWindow) this.getbfWindow();
        if (!this.bfWindow) return;  
        this.bfWindow.restore();
        this.bfWindow.bringToTop();
        await util.wait(1000);
        robot.keyTap("space");
        await util.wait(1000);
        if (this.firstAntiIdle) {
            await util.wait(1000);
            robot.keyTap("space");
            await util.wait(1000);
        }
        robot.keyTap("space");
        await util.wait(1000);
        this.bfWindow.minimize();
        await util.wait(1000);
        this.firstAntiIdle = false;
        return;
    }).bind(this);
    private async init() { 
        this.bfPath = `${await BFController.getDir(this.game)}\\${this.game.toLowerCase()}.exe`;
        this.emit("ready");
    }
    private async joinServerById(gameId:string) {
        let idToJoin = gameId;
        if (this.game === "BF4") {
            idToJoin = (await (await fetch(`https://keeper.battlelog.com/snapshot/${gameId}`)).json()).snapshot.gameId;
        }
        if (this.currentState !== GameState.IDLE) {
            await this.leaveServer();
            // Wait for Cloud Sync
            await util.wait(5000);
        }
        const launchArgs = ["-gameId", idToJoin, "-gameMode", "MP", "-role", "soldier", "-asSpectator", "false", "-parentSessinId", "-joinWithParty", "false", "-Origin_NoAppFocus"];
        child_process.spawn(this.bfPath, launchArgs);
    }
    private leaveServer():boolean {
        if (!this.bfWindow) this.getbfWindow();
        if (!this.bfWindow) return false;
        return process.kill(this.bfWindow.processId);
    }
    // Private because it throws an err if BF1 isn't installed.
    private static async getDir(game: BFGame):Promise<string> {
        let regEntry;
        if (game === "BF4") {
            regEntry =  "\\SOFTWARE\\EA Games\\Battlefield 4";
        } else if (game === "BF1") {
            regEntry =  "\\SOFTWARE\\EA Games\\Battlefield 1";
        } else {
            throw new Error("Game was not BFGame.");
        }
        return new Promise((resolve) => {
            const regKey = new winreg({                                       
                hive: winreg.HKLM,
                key: regEntry,
            });
            regKey.values((err, items) => {
                const bfDir = items.find(element => (element.name === "Install Dir"));
                resolve(bfDir.value);
            });
        });
    }
}