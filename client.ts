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
import { io } from "socket.io-client";
// Local Files
import protocol from "./resources/protocol.json";
const config = JSON.parse(fs.readFileSync("./config.json", {"encoding":"utf-8"}));
// Global Constants
let controlServer = process.argv.find(e => e.startsWith("--server="));
if (controlServer) {
    controlServer = controlServer.split("=")[1];
} else if (process.env["Seeder-ServerHost"]) {
    controlServer = process.env["Seeder-ServerHost"];
} else {
    console.log("Please define a seeder server with --server=hostname:port OR set env variable Seeder-ServerHost to your server's hostname:port.");
    process.exit(0);
}
let authToken = process.argv.find(e => e.startsWith("--authtoken="));
if (authToken) {
    authToken = authToken.split("=")[1];
} else if (process.env["Seeder-AuthToken"]) {
    authToken = process.env["Seeder-AuthToken"];
} else {
    console.log("Please specify your auth token with --authtoken=token OR set env variable Seeder-AuthToken.");
    process.exit(0);
}
console.log(`Seeder Control Server set to ${controlServer}`);
// Global Variables
let battlelog:Battlelog;
let serverInterface:ServerInterface;
let originInterface:OriginInterface;
// #region Origin
class OriginInterface extends EventEmitter {
    // If Origin is running AND accessable to the debugger.
    public originRunning = false;
    // If Origin is signed in to the proper account.
    public signedIn = false;
    // Self-explanitory
    public hasBF4 = false;
    public hasBF1 = false;
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
        if (!(await this.startDebugger())) {
            throw new Error("Error initializing Origin.");
        }
        // Get array of installed games
        // Shitty workaround due to old version of Debug Tools
        await this.originDebugger.Runtime.evaluate({"expression":"window.Origin.client.games.requestGamesStatus().then((out) => {window.currentGames = out;})"});
        let installedGames;
        while(!installedGames) {
            await wait(100);
            installedGames = JSON.parse((await this.originDebugger.Runtime.evaluate({"expression":"JSON.stringify(window.currentGames.updatedGames)"})).result.value);
        }
        await this.originDebugger.close();
        for (const game of installedGames) {
            if (OriginInterface.bf1OfferIds.includes(game.productId) && game.playable) this.hasBF1 = true;
            if (OriginInterface.bf4OfferIds.includes(game.productId) && game.playable) this.hasBF4 = true;
        }
        this.emit("ready");
        this.watchdogTimer = setInterval(this.originWatchdog, 30000);
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
        this.originInstance = child_process.spawn(`${process.env["ProgramFiles(x86)"]}\\Origin\\Origin.exe`, ["--remote-debugging-port=8081"]);
        this.originRunning = true;
        return;
    }
    private startDebugger = async ():Promise<boolean> => {
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
        return true;
    }
    // Bind this so that we can call the function from a timer without breaking things.
     private originWatchdog = (async () => {
         // If we're currently launching/initializing Origin, return.
         if (!this.signedIn) return;
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
             await this.startDebugger();
             return;
         }
     }).bind(this);
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
// #region Battlelog
class Battlelog extends EventEmitter {
    public gameState: GameState;
    public signedIn = false;
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
                    resolve(true);
                    this.emit("loggedIn");
                    this.gameState = GameState.IDLE;
                }
            });
        });
    }
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
// #region Comms
class ServerInterface extends EventEmitter {
    private socket;
    private battlelog: Battlelog;
    public currentTarget:ServerData = {
        "name":null,
        "guid":null,
        "user":"System",
        "timestamp":new Date().getTime(),
    };
    public currentGUID;
    constructor (serverAddress:string, authToken:string, battlelog: Battlelog) {
        super();
        this.battlelog = battlelog;
        this.socket = io(`wss://${serverAddress}/ws/seeder`, {  auth: {
            hostname: hostname(),
            token: authToken,
        }});
        // Socket Handlers
        this.socket.on("connect", async () => {
            this.updateGameState();
            this.newTargetHandler(await this.getTarget());
        });
        this.socket.on("newTarget", this.newTargetHandler);
        // Local Handlers
        this.battlelog.on("gameStateChange", this.updateGameState);
    }
    private updateGameState = (() => {
        this.socket.emit("gameStateUpdate", GameState[this.battlelog.gameState]);
    }).bind(this);
    private getTarget():Promise<ServerData> {
        return new Promise((resolve) => {
            this.socket.emit("getTarget", (newTarget:ServerData) => {
                resolve(newTarget);
            });
        });
    }
    private newTargetHandler = (async (newTarget:ServerData) => {
        // If there's no change, return.
        if(newTarget.guid === this.currentTarget.guid) {
            return;
        }
        this.currentTarget = newTarget;
        // If the new GUID is null, disconnect (if we're not idle already)
        if (!newTarget.guid) {
            if (this.battlelog.gameState !== GameState.IDLE) {
                await this.battlelog.leaveServer();
                console.log(`Instructed to disconnect by user ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
            }
            return;
        }
        await this.battlelog.leaveServer();
        await wait(250);
        await this.battlelog.joinServer(newTarget.guid!);
        console.log(`New target set to:\n${newTarget.name}\n${newTarget.guid}\nBy: ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
    }).bind(this)
}
type ServerData = {
    "name":string | null,
    "guid":string | null,
    "user":string,
    "timestamp":number
}

// #endregion
// #region Helpers
async function evalCode(client, code:string) {
    return (await client.Runtime.evaluate({ "expression": code })).result.value;
}
async function antiIdle() {
    if (battlelog.gameState !== GameState.IN_GAME) return;
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
    await wait(1000);
    robot.keyTap("space");
    await wait(1000);
    bf4Window.minimize();
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
    originInterface = new OriginInterface(config.email, config.password);
    await waitForEvent(originInterface, "ready");
    console.log("Initializing Battlelog.");
    battlelog = new Battlelog();
    await waitForEvent(battlelog, "readyToLogin");
    // Keep getting gateway timeouts. This way, it tries until it logs in.
    let loggedIn = false;
    while(!loggedIn) {
        loggedIn = await battlelog.login(config.email, config.password);
    }
    serverInterface = new ServerInterface(controlServer!, authToken!, battlelog );
    battlelog.on("gameStateChange", async (launcherEvent: LauncherEvent, lastGameState: GameState) => {
        console.log(`${GameState[lastGameState]} -> ${GameState[battlelog.gameState]}`);
    });
}
main();