import * as nodeWindows from "node-window-manager";
import * as robot from "robotjs";
import EventEmitter from "events";
import child_process from "child_process";
import winreg from "winreg";
import * as util from "./util";
import { ServerData } from "./ServerInterface";
export default class BattlefieldOne extends EventEmitter {
    private currentState:OneState = OneState.IDLE;
    private currentTarget:ServerData = {
        "name":null,
        "guid":null,
        "user":"System",
        "timestamp":new Date().getTime(),
    }
    private bf1Window: nodeWindows.Window | null = null;
    private bf1Path!: string;
    private refreshInfoTimer: number | null = null;
    private launchTimer: ReturnType<typeof setTimeout> | null = null;
    private firstAntiIdle = true;
    // Target
    get target():ServerData {
        return this.currentTarget;
    }
    set target(newTarget: ServerData) {
        if ((this.currentTarget.guid === newTarget.guid)) return;
        if (!newTarget.guid) {
            this.leaveServer();
        } else {
            this.joinServerById(newTarget.guid);
        }
        this.currentTarget = newTarget;
    }
    // State
    get state():OneState {
        return this.currentState;
    }
    set state(newState:OneState) {
        if (newState === this.state) return;
        this.firstAntiIdle = true;
        const oldState = this.currentState;
        this.currentState = newState;
        this.emit("newState", oldState);
        // Once game launches, set a timer to restart the connection process.
        if (newState === OneState.LAUNCHING) {
            if (this.launchTimer) {
                clearTimeout(this.launchTimer);
                this.launchTimer = null;
            }
            this.launchTimer = setTimeout(() => {
                if (!this.currentTarget.guid) return;
                this.joinServerById(this.currentTarget.guid);
            }, 60000);
        }
        // If the new state isn't joining, clear the failsafe timeout.
        if ((newState !== OneState.LAUNCHING) && this.launchTimer) {
            clearTimeout(this.launchTimer);
            this.launchTimer = null;
        }
        // Detect unintentional disconnects & rejoin.
        if (this.currentTarget.guid && (newState === OneState.DISCONNECTED)) {
            this.joinServerById(this.currentTarget.guid);
            return;
        }
    }
    constructor() {
        super();
        this.init();
    }
    public checkGame():void {
        this.getBf1Window();
        if ((!this.bf1Window) && (this.state !== OneState.LAUNCHING)) {
            this.state = OneState.IDLE;
            return;
        }
    }
    private getBf1Window() {
        let bf1Window:nodeWindows.Window | null = null;
        const windows:Array<nodeWindows.Window> = nodeWindows.windowManager.getWindows();
        for (const window of windows) {
            if (window.getTitle() === "Battlefield™ 1") {
                bf1Window = window;
                break;
            }
        }
        this.bf1Window = bf1Window;
    }
    public antiIdle = (async () => {
        if (this.currentState !== OneState.ACTIVE) return;
        if (!this.bf1Window) this.getBf1Window();
        if (!this.bf1Window) return;  
        this.bf1Window.restore();
        this.bf1Window.bringToTop();
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
        this.bf1Window.minimize();
        await util.wait(1000);
        this.firstAntiIdle = false;
        return;
    }).bind(this);
    private async init() { 
        this.bf1Path = `${await BattlefieldOne.getBF1Dir()}\\bf1.exe`;
        this.emit("ready");
    }
    private async joinServerById(gameId:string) {
        if (this.currentState !== OneState.IDLE) {
            await this.leaveServer();
            // Wait for Cloud Sync
            await util.wait(5000);
        }
        const launchArgs = ["-gameId", gameId, "-gameMode", "MP", "-role", "soldier", "-asSpectator", "false", "-parentSessinId", "-joinWithParty", "false"];
        child_process.spawn(this.bf1Path, launchArgs);
    }
    private leaveServer():boolean {
        if (!this.bf1Window) this.getBf1Window();
        if (!this.bf1Window) return false;
        return process.kill(this.bf1Window.processId);
    }
    // Private because it throws an err if BF1 isn't installed.
    private static async getBF1Dir():Promise<string> {
        const bf1Reg = "\\SOFTWARE\\EA Games\\Battlefield 1";
        return new Promise((resolve) => {
            const regKey = new winreg({                                       
                hive: winreg.HKLM,
                key: bf1Reg,
            });
            regKey.values((err, items) => {
                const bf1Dir = items.find(element => (element.name === "Install Dir"));
                resolve(bf1Dir.value);
            });
        });
    }
}
export enum OneState {
    "IDLE",
    "LAUNCHING",
    "JOINING",
    "ACTIVE",
    "DISCONNECTED"
}