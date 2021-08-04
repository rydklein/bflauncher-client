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
    public game:BFGame;
    public accountName:string;
    private currentState:GameState = GameState.IDLE;
    private currentTarget:ServerData = {
        "name":null,
        "guid":null,
        "user":"System",
        "timestamp":new Date().getTime(),
    }
    private bfWindow:nodeWindows.Window | null = null;
    private bfPath!:string;
    private launchTimer:ReturnType<typeof setTimeout> | null = null;
    private logger;
    private firstAntiIdle = true;
    private dxError = false;
    // Target
    get target():ServerData {
        return this.currentTarget;
    }
    set target(newTarget:ServerData) {
        if ((this.currentTarget.guid === newTarget.guid)) return;
        const oldTarget = this.currentTarget;
        this.currentTarget = newTarget;
        if (!newTarget.guid) {
            this.leaveServer();
            this.logger.log(`Ordered to disconnect from:\n${oldTarget.name} (${oldTarget.guid})\nBy: ${newTarget.user} (${new Date(newTarget.timestamp).toLocaleString()})`);
        } else {
            this.joinServerById(newTarget.guid);
            this.logger.log(`New target set to:\n${newTarget.name} (${newTarget.guid})\nBy: ${newTarget.user} (${new Date(newTarget.timestamp).toLocaleString()})`);
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
        this.logger.log(`${GameState[oldState]} -> ${GameState[newState]}`);
        // Clear any timers from other game states.
        if (this.launchTimer) {
            clearTimeout(this.launchTimer);
            this.launchTimer = null;
        }
        // 1 minute timeout to go from launching to joining.
        if (newState === GameState.LAUNCHING) {
            this.launchTimer = setTimeout(() => {
                if (!this.currentTarget.guid) {
                    this.leaveServer();
                    return;
                }
                this.joinServerById(this.currentTarget.guid);
            }, 60000);
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
    constructor(currentGame:BFGame, accountName:string) {
        super();
        this.game = currentGame;
        this.accountName = accountName;
        this.logger = new util.Logger(`${this.game}Controller`);
        setInterval(this.watchdog, 30000);
        this.init();
    }
    public antiIdle = (async () => {
        if (this.currentState !== GameState.ACTIVE) return;
        this.setBFWindow();
        if (!this.bfWindow) return;
        this.bfWindow.restore();
        this.bfWindow.bringToTop();
        await util.wait(2500);
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
        this.logger.log("Ready.");
    }
    private async joinServerById(gameId:string) {
        let idToJoin = gameId;
        if (this.game === "BF4") {
            try {
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
            } catch {
                this.logger.log("Error fetching server info. Game will not launch.");
                return;
            }
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
                await util.waitForEvent(this, "newState", 15000);
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
    private watchdog = (async () => {
        if (!this.currentTarget.guid && (this.currentState !== GameState.IDLE)) return await this.leaveServer();
        if (this.currentTarget.guid && (this.currentState === GameState.ACTIVE) && this.game === "BF4") {
            const keeperData = (await (await fetch(`https://keeper.battlelog.com/snapshot/${this.currentTarget.guid}`)).json()).snapshot.teamInfo;
            if (!keeperData) {
                this.logger.log("Error fetching keeper data.");
                return;
            }
            let playerFound = false;
            for (const team in keeperData) {
                for (const player in keeperData[team].players) {
                    if (keeperData[team].players[player].name === this.accountName) {
                        playerFound = true;
                        break;
                    }
                }
                if (playerFound) break;
            }
            if (!playerFound) {
                if (this.dxError) {
                    this.dxError = false;
                    return await this.joinServerById(this.currentTarget.guid);
                } else {
                    this.dxError = true;
                }
            } else {
                this.dxError = false;
            }
        }
    }).bind(this);
    private static getDir(game:BFGame):Promise<string> {
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
                if (err) throw new Error(`Error finding install directory for ${game}. Please contact BadPylot.`);
                const bfDir = items.find(element => (element.name === "Install Dir"));
                resolve(bfDir.value);
            });
        });
    }
}