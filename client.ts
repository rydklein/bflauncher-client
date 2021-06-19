// Packages
import CRI from "chrome-remote-interface";
import { hostname } from "os";
import * as nodeWindows from "node-window-manager";
import * as robot from "robotjs";
import path from "path";
import EventEmitter from "events";
import child_process from "child_process";
import puppeteer from "puppeteer-core";
import downloadChrome from "download-chromium";
import fetch from "node-fetch";
import ps from "ps-node";
import fs from "fs";
import { io, Socket } from "socket.io-client";
import winreg from "winreg";
// Local Files
import protocol from "./resources/protocol.json";
const config = JSON.parse(fs.readFileSync("./config.json", {"encoding":"utf-8"}));
import buildConfig from "./buildconfig/config.js";
// Global Constants
const {controlServer, authToken} = buildConfig.getConfig();
// Global Variables
let battlelog:Battlelog;
let battlefieldOne:BattlefieldOne;
let serverInterface:ServerInterface;
let originInterface:OriginInterface;
// #region Origin
class OriginInterface extends EventEmitter {
    // If Origin is running AND accessable to the debugger.
    public originRunning = false;
    // If Origin is signed in to the proper account.
    public signedIn = false;
    // Self-explanatory
    public hasBF4 = false;
    public hasBF1 = false;
    // Origin Username
    public playerName!:string;
    // Whether user is connected to BF1 server.
    // Have to do some sketchy shit to get it though...
    public inBF1Game = false;
    // Private
    private email:string;
    private password:string;
    private originInstance!:child_process.ChildProcess;
    private originDebugger;
    private watchdogTimer;
    constructor(email, password) {
        super();
        this.email = email;
        this.password = password;
        this.init();
    }
    private async init() {
        await this.restartOrigin();
        if (!(await this.initOrigin())) {
            throw new Error("Error initializing Origin.");
        }
        // Get array of installed games
        this.playerName = await evalCode(this.originDebugger, "Origin.user.originId()");
        await this.originDebugger.Runtime.evaluate({"expression":"window.Origin.client.games.requestGamesStatus().then((out) => {window.currentGames = out;})"});
        let installedGames;
        while(!installedGames) {
            try {
                installedGames = JSON.parse((await evalCode(this.originDebugger, "JSON.stringify(window.currentGames.updatedGames)")));
            } catch {
                await wait(100);
            }
        }
        for (const game of installedGames) {
            if (OriginInterface.bf1OfferIds.includes(game.productId) && game.playable) this.hasBF1 = true;
            if (OriginInterface.bf4OfferIds.includes(game.productId) && game.playable) this.hasBF4 = true;
        }
        this.emit("ready");
        this.watchdogTimer = setInterval(this.originWatchdog, 30000);
        setInterval(this.statusPoller, 5000);
    }
    // Bind this to function so that when called from a timer, we can still refer to this.
    private restartOrigin = async ():Promise<void> => {
        if (!this.originInstance) {
            // findProcess is very inefficient/slow so we try and avoid it if at all possible.
            const originProcess: any = await OriginInterface.findProcess("Origin.exe");
            if (originProcess) {
                process.kill(originProcess.pid);
            }
        } else {
            this.originInstance.kill();
        }
        this.originRunning = false;
        // Launch it again!
        this.originInstance = child_process.spawn(`${process.env["ProgramFiles(x86)"]}\\Origin\\Origin.exe`, ["-StartClientMinimized", "--remote-debugging-port=8081"]);
        this.originRunning = true;
        return;
    }
    private initOrigin = async ():Promise<boolean> => {
        const debugOptions: any = {
            port: "8081",
        };
        const debugOptionsProtocol: any = {
            port: "8081",
            protocol: protocol,
        };
        let tabs;
        // Wait for debugger to connect.
        while(!tabs){
            try {
                tabs = await CRI.List(debugOptions);
            } catch {
                // Don't lock up the process
                await wait(500);
                continue;
            }
        }
        let loginTab;
        let homePage;
        while (!(loginTab || homePage)) {
            // Don't lock up the process
            await wait(500);
            // List our tabs again
            tabs = await CRI.List(debugOptions);
            // Look to see if we're already signed in. if so, break.
            // Look for our login tab &/or home page.
            // TODO: Find a way to find these tabs that doesn't depend on href, at least the one with USA in it.
            homePage = tabs.find(element => element.url.includes("origin.com/usa"));
            loginTab = tabs.find(element => element.url.includes("signin.ea.com"));
        }
        if (homePage) this.signedIn = true;
        if (loginTab) this.signedIn = false;
        // If we need to login
        if (loginTab) {
            debugOptionsProtocol.target = loginTab.webSocketDebuggerUrl;
            const client = await CRI(debugOptionsProtocol);
            await client.Runtime.enable();
            await client.Page.enable();
            console.log("Signing into Origin.");
            // TODO: Add error handling. Too much work at the moment.
            await evalCode(client, `document.getElementById('email').value = '${this.email}'`);
            await evalCode(client, `document.getElementById('password').value = '${this.password}'`);
            await evalCode(client, "document.getElementById('rememberMe').checked = true");
            await wait(10);
            // Resolve promise if the load event fires.
            const loggedInPromise = new Promise<boolean>((resolve) => {
                client.on("Page.loadEventFired", () => {
                    resolve(true);
                });
            });
            // If it's equal to 0, it worked. If not, uh oh.
            evalCode(client, "document.getElementById('logInBtn').click()");
            const loginSuccess = await Promise.race([loggedInPromise, wait(5000)]);
            await client.close();
            if (loginSuccess) {
                this.signedIn = true;
            } else {
                this.signedIn = false;
                return false;
            }
            delete debugOptionsProtocol.target;
        }
        while (!homePage) {
            await wait(250);
            tabs = await CRI.List(debugOptions);
            // Homepage has to exist since we already signed in successfully.
            homePage = tabs.find(element => element.url.includes("origin.com/usa"));
        }
        debugOptionsProtocol.target = homePage.webSocketDebuggerUrl;
        this.originDebugger = await CRI(debugOptionsProtocol);
        await this.originDebugger.Page.enable();
        await Promise.race([this.originDebugger.Page.loadEventFired(), wait(5000)]);
        await this.originDebugger.Runtime.enable();
        // Shitty workaround due to old version of Debug Tools
        // Detects when LAUNCHING or leaving game and attaches it to window object
        // Since we can't do much to interact with the debugger, we just have to poll it whenever we wanna check our status.
        await evalCode(this.originDebugger, "Origin.events.on('xmppPresenceChanged', (gameEvent) => { if (gameEvent.gameActivity.title !== 'Battlefield™ 1') return; window.lastEvent = JSON.parse(JSON.stringify(gameEvent)) })");
        return true;
    }
    // Bind this so that we can call the function from a timer without breaking things.
     private originWatchdog = (async () => {
         // If we're currently launching/initializing Origin, return.
         if (!(this.signedIn && this.originRunning)) return;
         let success = true;
         try {
             // Check if Origin's frozen using the magic link.
             await fetch("http://127.0.0.1:3215/ping", { timeout: 1000 });
         } catch (e) {
             success = false;
         }
         if (!success) {
             console.log("Origin hung. Relaunching...");
             await this.restartOrigin();
             await this.initOrigin();
             return;
         }
     }).bind(this);
     private statusPoller = (async () => {
         let lastEvent;
         try {
             lastEvent = JSON.parse(await evalCode(this.originDebugger, "JSON.stringify(window.lastEvent)"));
         } catch {
             return;
         }
         const lastBF1Status = this.inBF1Game;
         this.inBF1Game = lastEvent.gameActivity.joinable;
         if ((this.inBF1Game !== lastBF1Status)) {
             this.emit("bf1StatusChange", this.inBF1Game);
         }
     }).bind(this)
     // Promisify ps.lookup
     static findProcess(name: string):Promise<Record<string, unknown>> {
         return new Promise(function (resolve, reject) {
             ps.lookup({ command: name }, function (err, results) {
                 if (err) {
                     reject(err);
                 }
                 resolve(results[0]);
             });
         });
     }
    static bf1OfferIds = ["Origin.OFR.50.0001662", "Origin.OFR.50.0001385", "Origin.OFR.50.0000557"];
    static bf4OfferIds = ["OFB-EAST:109552316", "OFB-EAST:109549060", "OFB-EAST:109546867", "OFB-EAST:109552312"];
}
// #endregion
// #region Comms
class ServerInterface extends EventEmitter {
    private socket:Socket;
    public currentGUID;
    constructor (serverAddress:string, authToken:string) {
        super();
        this.socket = io(`wss://${serverAddress}/ws/seeder`, {  auth: {
            hostname: hostname(),
            token: authToken,
        }});
        // Socket Handlers
        this.socket.on("connect", async () => {
            this.emit("connected");
        });
        this.socket.on("newTarget", this.newTargetHandler);
    }
    private getTarget():Promise<Record<string, ServerData>> {
        return new Promise((resolve) => {
            this.socket.emit("getTarget", (newTarget:Record<string, ServerData>) => {
                resolve(newTarget);
            });
        });
    }
    private newTargetHandler = (async (game:bfGame, newTarget:ServerData) => {
        this.emit("newTarget", game, newTarget);
    }).bind(this);
    public updateBF4State = (newGameState:GameState) => {
        this.socket.emit("gameStateUpdate", GameState[newGameState]);
    }
    public updateBF1State = (newOneState:OneState) => {
        this.socket.emit("oneStateUpdate", OneState[newOneState]);
    }
    public async initTargets() {
        const initTargets = await this.getTarget();
        this.newTargetHandler("BF4", initTargets["BF4"]);
        this.newTargetHandler("BF1", initTargets["BF1"]);
    }
}
type ServerData = {
    "name":string | null,
    "guid":string | null,
    "user":string,
    "timestamp":number
}
type bfGame = "BF4" | "BF1";
// #endregion
// #region Battlelog
class Battlelog extends EventEmitter {
    public gameState: GameState;
    public signedIn = false;
    public currentTarget:ServerData = {
        "name":null,
        "guid":null,
        "user":"System",
        "timestamp":new Date().getTime(),
    }
    private browser!: puppeteer.Browser;
    private blPage!: puppeteer.Page;
    constructor() {
        super();
        this.gameState = GameState.INIT;
        this.init();
    }
    private async init(): Promise<void> {
        const downloadChromeOptions = {
            "revision": "884014",
            "installPath":path.join(process.cwd(), ".local-chromium"),
        };
        const exec = await downloadChrome(downloadChromeOptions);
        const puppeteerOptions:puppeteer.LaunchOptions & puppeteer.BrowserLaunchArgumentOptions = {
            "headless": true,
            "executablePath":exec,
        };
        this.browser = await puppeteer.launch(puppeteerOptions);
        this.blPage = (await this.browser.pages())[0];
        await this.blPage.goto("https://battlelog.battlefield.com/bf4/");
        // Set up our event emitters for game state changes
        // TODO: Set up a setter for gameState and move emitters to there.
        this.blPage.on("console", (msg) => {
            let message: Array<any>;
            try {
                message = JSON.parse(msg.text());
            } catch {
                return;
            }
            if (message.length === 4) {
                if ((typeof eventToState[message[2]]) !== "undefined") {
                    const lastGameState = this.gameState;
                    this.gameState = eventToState[message[2]];
                    const launcherEvent: LauncherEvent = {
                        eventInfo: message[0],
                        titleID: message[1],
                        launcherState: message[2],
                        personaID: message[3],
                    };
                    if (this.gameState !== lastGameState) {
                        this.emit("gameStateChange", launcherEvent, lastGameState);
                    }
                } else {
                    this.emit("unknownMessage", message);
                }
            }
        });
        this.emit("readyToLogin");
    }
    public async login(email: string, password: string): Promise<boolean> {
        await this.blPage.goto("https://accounts.ea.com/connect/auth?locale=en_US&state=bf4&redirect_uri=https%3A%2F%2Fbattlelog.battlefield.com%2Fsso%2F%3Ftokentype%3Dcode&response_type=code&client_id=battlelog&display=web%2Flogin");
        await this.blPage.type("#email", email);
        await this.blPage.type("#password", password);
        await this.blPage.click("#btnLogin");
        return new Promise((resolve) => {
            this.blPage.once("load", async () => {
                if ((await this.blPage.evaluate(() => {
                    return document.getElementsByClassName("username");
                })).length === 0) {
                    resolve(false);
                } else {
                    this.emit("loggedIn");
                    this.gameState = GameState.IDLE;
                    resolve(true);
                }
            });
        });
    }
    public antiIdle = (async () => {
        if (this.gameState !== GameState.IN_GAME) return;
        const windows:Array<nodeWindows.Window> = nodeWindows.windowManager.getWindows();
        let bf4Window;
        for (const window of windows) {
            if (window.getTitle() === "Battlefield 4") {
                bf4Window = window;
                break;
            }
        }
        if (!bf4Window) return;
        bf4Window.restore();
        bf4Window.bringToTop();
        await wait(250);
        robot.keyTap("space");
        await wait(250);
        bf4Window.minimize();
        await wait(250);
        return;
    }).bind(this);
    
    public async joinServer(guid:string): Promise<boolean> {
        const jsGoto = await this.blPage.goto(`https://battlelog.battlefield.com/bf4/servers/show/pc/${guid}`);
        if (!jsGoto.ok()) {
            switch(jsGoto.status()) {
            case 504:
                return await this.joinServer(guid);
            case 403:
                return false;
            default:
                console.log(`Error: status code ${jsGoto.status()} not handled.`);
                return false;
            }
        }
        await this.blPage.addScriptTag({ path: path.join(__dirname, "resources/bleventhook.js") });
        await this.blPage.click("[data-track=\"serverbrowser.server.join\"]");
        return true;
    }
    public async leaveServer(): Promise<boolean> {
        try {
            await this.blPage.evaluate("gamemanager.cancelGameLaunch(gamemanager.launcherState.currentGame);");
        } catch {
            return false;
        }
        return true;
    }
}
type LauncherEvent =
    {
        eventInfo: Record<string, unknown>,
        titleID: number,
        launcherState: string,
        personaID: number
    }
enum GameState {
    "INIT", "IDLE", "RESERVING_SLOT", "QUEUED", "LAUNCHING", "LOADING", "IN_GAME", "EXITING"
}
const eventToState = {
    "RESERVING_SLOT": GameState.RESERVING_SLOT,
    "State_ConnectToGameId": GameState.LAUNCHING,
    "PENDING": GameState.LAUNCHING,
    "READY": GameState.LAUNCHING,
    "State_NotLoggedIn": GameState.LOADING,
    "State_Connecting": GameState.LOADING,
    "State_GameLoading": GameState.LOADING,
    "State_Game": GameState.IN_GAME,
    "State_GameLeaving": GameState.EXITING,
    "GAMEISGONE": GameState.IDLE,
};

// #endregion
// #region BF1
class BattlefieldOne extends EventEmitter {
    public currentState:OneState = OneState.IDLE;
    private currentTarget:ServerData = {
        "name":null,
        "guid":null,
        "user":"System",
        "timestamp":new Date().getTime(),
    }
    private bf1Window: nodeWindows.Window | null = null;
    private bf1Path!: string;
    private refreshInfoTimer;
    private firstAntiIdle = true;
    constructor() {
        super();
        this.init();
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
    get target() {
        return this.currentTarget;
    }
    public async rejoinTarget() {
        if (!this.currentTarget.guid) {
            this.leaveServer();
            return;
        }
        await this.joinServerById(this.currentTarget.guid);
    }
    public externalPlayingHandler = ((inGame:boolean) => {
        if (this.currentState !== OneState.ACTIVE) {
            if (inGame) this.setState(OneState.ACTIVE);
        }
        if (this.currentState === OneState.ACTIVE) {
            if (!inGame)
            {
                this.setState(OneState.LAUNCHING);
                this.rejoinTarget();
                console.log("Detected disconnection. Rejoining...");
            }
        }
    }).bind(this);
    public antiIdle = (async () => {
        if (this.currentState !== OneState.ACTIVE) return;

        if (!this.bf1Window) return;
        this.bf1Window.restore();
        this.bf1Window.bringToTop();
        await wait(250);
        robot.keyTap("space");
        await wait(750);
        if (this.firstAntiIdle) {
            await wait(500);
            robot.keyTap("space");
            await wait(750);
        }
        robot.keyTap("space");
        await wait(250);
        this.bf1Window.minimize();
        await wait(250);
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
            await wait(1000);
        }
        this.setState(OneState.LAUNCHING);
        const launchArgs = ["-gameId", gameId, "-gameMode", "MP", "-role", "soldier", "-asSpectator", "false", "-parentSessinId", "-joinWithParty", "false"];
        const bf1Child = child_process.spawn(this.bf1Path, launchArgs);
        bf1Child.once("exit", async () => {
            await wait(1000);
            let bf1Window;
            let i = 0;
            while ((!bf1Window) && (i < 50)) {
                const windows:Array<nodeWindows.Window> = nodeWindows.windowManager.getWindows();
                await wait(500);
                for (const window of windows) {
                    if (window.getTitle() === "Battlefield™ 1") {
                        bf1Window = window;
                        break;
                    }
                }
                i++;
            }
            if(!bf1Window) {
                this.setState(OneState.IDLE);
            }
            this.bf1Window = bf1Window;
        });
    }
    private leaveServer() {
        return new Promise<void>((resolve) => {
            if (!this.bf1Window) return resolve();
            process.kill(this.bf1Window.processId);
            this.setState(OneState.IDLE);
            resolve();
        });
    }
    private setState(newState:OneState) {
        if (newState === this.currentState) return;
        this.firstAntiIdle = true;
        const oldState = this.currentState;
        this.currentState = newState;
        this.emit("newState", oldState);
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
enum OneState {
    "IDLE",
    "LAUNCHING",
    "ACTIVE"
}
// #endregion
// #region Helpers
async function evalCode(client, code:string) {
    const output = await client.Runtime.evaluate({ "expression": code });
    return output.result.value;
}
function wait(delay) {
    return new Promise(function (resolve) {
        setTimeout(resolve, delay);
    });
}
function waitForEvent(emitter:EventEmitter, eventName:string) {
    return new Promise((res) => {
        emitter.once(eventName, res);
    });
}
// #endregion
async function main() {
    // Initialize OriginInterface and Battlelog (if needed)
    console.log("Initializing Origin.");
    originInterface = new OriginInterface(config.email, config.password);
    await waitForEvent(originInterface, "ready");
    console.log("Initializing Server Interface.");
    serverInterface = new ServerInterface(controlServer!, authToken!);
    await waitForEvent(serverInterface, "connected");
    if (originInterface.hasBF4) {
        console.log("[BF4] Initializing Battlelog.");
        battlelog = new Battlelog();
        await waitForEvent(battlelog, "readyToLogin");
        // Keep getting gateway timeouts. This way, it tries until it logs in.
        let loggedIn = false;
        while(!loggedIn) {
            loggedIn = await battlelog.login(config.email, config.password);
        }
        console.log("[BF4] Battlelog ready.");
        battlelog.on("gameStateChange", async (launcherEvent: LauncherEvent, lastGameState: GameState) => {
            console.log(`[BF4] ${GameState[lastGameState]} -> ${GameState[battlelog.gameState]}`);
            serverInterface.updateBF4State(battlelog.gameState);
        });
        console.log("[BF4] Ready.");
    }
    if (originInterface.hasBF1) {
        console.log("[BF1] Initializing BF1.");
        battlefieldOne = new BattlefieldOne();
        await waitForEvent(battlefieldOne, "ready");
        console.log("[BF1] Ready.");
        battlefieldOne.on("newState", (oldState:OneState) => {
            console.log(`[BF1] ${OneState[oldState]} -> ${OneState[battlefieldOne.currentState]}`);
            serverInterface.updateBF1State(battlefieldOne.currentState);
        });
        originInterface.on("bf1StatusChange", battlefieldOne.externalPlayingHandler);
        serverInterface.on("newTarget", async (newGame:bfGame, newTarget:ServerData) => {
            if((newGame === "BF4") && originInterface.hasBF4) {
                serverInterface.updateBF4State(battlelog.gameState);
                // TODO: Move all of this logic into Battlelog, update it to use setter like BattlefieldOne
                if(newTarget.guid === battlelog.currentTarget.guid) return;
                battlelog.currentTarget = newTarget;
                // If the new GUID is null, disconnect (if we're not idle already)
                if (!newTarget.guid) {
                    if (battlelog.gameState !== GameState.IDLE) {
                        await battlelog.leaveServer();
                        console.log(`[BF4] Instructed to disconnect by user ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
                    }
                    return;
                }
                await battlelog.leaveServer();
                await wait(250);
                await battlelog.joinServer(newTarget.guid!);
                console.log(`[BF4] New target set to:\n${newTarget.name}\n${newTarget.guid}\nBy: ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
            }
            if (newGame === "BF1" && originInterface.hasBF1) {
                serverInterface.updateBF1State(battlefieldOne.currentState);
                if (newTarget.guid === battlefieldOne.target.guid) return;
                battlefieldOne.target = newTarget;
                if (newTarget.guid) {
                    console.log(`[BF1] New target set to:\n${newTarget.name}\n${newTarget.guid}\nBy: ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
                } else {
                    console.log(`[BF1] Instructed to disconnect by user ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
                }
            }
        });
        serverInterface.initTargets();
    }
    setInterval(async () => {
        if (originInterface.hasBF4) {
            await battlelog.antiIdle();
        }
        if (originInterface.hasBF1) {
            await battlefieldOne.antiIdle();
        }
    }, 30000);
}
main();