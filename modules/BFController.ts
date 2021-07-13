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
    private game:BFGame;
    private currentState:GameState = GameState.IDLE;
    private currentTarget:ServerData = {
        "name":null,
        "guid":null,
        "user":"System",
        "timestamp":new Date().getTime(),
    }
    private bfWindow:nodeWindows.Window | null = null;
    private bfPath!:string;
    private refreshInfoTimer:number | null = null;
    private launchTimer:ReturnType<typeof setTimeout> | null = null;
    private firstAntiIdle = true;
    // Target
    get target():ServerData {
        return this.currentTarget;
    }
    set target(newTarget:ServerData) {
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
        // Clear any timers from other game states.
        if (this.launchTimer) {
            clearTimeout(this.launchTimer);
            this.launchTimer = null;
        }
        // 20 seconds timeout to go from launching to joining.
        if (newState === GameState.LAUNCHING) {
            this.launchTimer = setTimeout(() => {
                if (!this.currentTarget.guid) {
                    this.leaveServer();
                    return;
                }
                this.joinServerById(this.currentTarget.guid);
            }, 30000);
        }
        // 2 minute timeout to join
        if (newState === GameState.JOINING) {
            this.launchTimer = setTimeout(() => {
                if (!this.currentTarget.guid) {
                    this.leaveServer();
                    return;
                }
                this.joinServerById(this.currentTarget.guid);
            }, 120000);
        }
        // Detect unintentional disconnects & rejoin.
        if (this.currentTarget.guid && (newState === GameState.IDLE)) {
            this.joinServerById(this.currentTarget.guid);
            return;
        }
    }
    constructor(currentGame:BFGame) {
        super();
        this.game = currentGame;
        this.init();
    }
    public antiIdle = (async () => {
        if (this.currentState !== GameState.ACTIVE) return;
        this.setBFWindow();
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
            const idReq = await (await fetch(`https://battlelog.battlefield.com/bf4/servers/show/PC/${gameId}`, {
                "headers": {
                    "User-Agent": "Mozilla/5.0 SeederManager",
                    "Accept": "*/*",
                    "X-AjaxNavigation": "1",
                    "X-Requested-With": "XMLHttpRequest",
                },
                "method": "GET",
            })).json();
            idToJoin = idReq.context.server.gameId;
        }
        if (this.currentState !== GameState.IDLE) {
            await this.leaveServer();
            // Wait for Cloud Sync
            await util.wait(5000);
        }
        const launchArgs = ["-gameId", idToJoin.toString(), "-gameMode", "MP", "-role", "soldier", "-asSpectator", "false", "-parentSessinId", "-joinWithParty", "false", "-Origin_NoAppFocus"];
        child_process.spawn(this.bfPath, launchArgs);
        if (this.launchTimer) {
            clearTimeout(this.launchTimer);
            this.launchTimer = null;
        }
        // If we don't go from idle to another state in 30 seconds, retry.
        this.launchTimer = setTimeout(() => {
            if (!this.currentTarget.guid) {
                this.leaveServer();
                return;
            }
            this.joinServerById(this.currentTarget.guid);
        }, 30000);
    }
    private async leaveServer():Promise<void> {
        this.setBFWindow();
        if (!this.bfWindow) {
            if (this.currentState === GameState.LAUNCHING) {
                await Promise.race([util.wait(15000), util.waitForEvent(this, "newState")]);
            }
            this.setBFWindow();
        }
        if (!this.bfWindow) return;
        process.kill(this.bfWindow.processId);
        await util.wait(1000);
    }
    private setBFWindow() {
        this.bfWindow = util.getBFWindow(this.game);
    }
    private static async getDir(game:BFGame):Promise<string> {
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