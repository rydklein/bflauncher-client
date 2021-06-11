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
let originChildProcess:  child_process.ChildProcess;
let originLaunched: boolean;
let signingIn = false;

// #region Origin
async function originSignIn():Promise<void> {
    if (signingIn) return;
    signingIn = true;
    originLaunched = false;
    // Find Origin.exe's PID and kill it.
    // If this is the first launch, and originChildProcess doesn't exist yet:
    if (!originChildProcess) {
        // findProcess is very inefficient/slow so we try and avoid it if at all possible.
        const originProcess: any = await findProcess("Origin.exe");
        if (originProcess) {
            process.kill(originProcess.pid);
        }
    } else {
        originChildProcess.kill();
    }
    console.log("Relaunching Origin...");
    await wait(250);
    // Launch it again!
    originChildProcess = child_process.spawn(`${process.env["ProgramFiles(x86)"]}\\Origin\\Origin.exe`, ["--remote-debugging-port=8081"]);
    console.log("Relaunched Origin. Waiting for Origin to finish starting...");
    await wait(5000);
    // Initialize our CRI client.
    const debugOptions: any = {
        port: "8081",
    };
    let tabs;
    while(!tabs){
        try {
            tabs = await CRI.List(debugOptions);
        } catch {
            await wait(1000);
            continue;
        }
    }
    let loginTab;
    while (!loginTab) {
        // Don't lock up the process
        await wait(500);
        // List our tabs again
        tabs = await CRI.List(debugOptions);
        // Look to see if we're already signed in. if so, break.
        if (tabs.find(element => element.url.includes("origin.com/usa"))) break;
        // Look for our login tab.
        loginTab = tabs.find(element => element.url.includes("signin.ea.com"));
    }
    // If we need to login
    if (loginTab) {
        debugOptions.protocol = protocol;
        debugOptions.target = loginTab.webSocketDebuggerUrl;
        const client = await CRI(debugOptions);
        await client.Runtime.enable();
        console.log("Signing into Origin.");
        // TODO: Add error handling. Too much work at the moment.
        await evalCode(client, `document.getElementById('email').value = '${config.email}`);
        await evalCode(client, `document.getElementById('password').value = '${config.password}'`);
        await evalCode(client, "document.getElementById('rememberMe').checked = true");
        await wait(10);
        await evalCode(client, "document.getElementById('logInBtn').click()");
        await client.close();  
        console.log("Now signed into Origin.");
    } else {
        console.log("Already signed into Origin.");
    }
    originLaunched = true;
    signingIn = false;
    return;
}
async function originWatchdog() {
    // If we're currently launching Origin, return.
    if (!originLaunched) return;
    let success = true;
    try {
        // Check if Origin's frozen using the magic link.
        await fetch("http://127.0.0.1:3215/ping", { timeout: 1000 });
    } catch (e) {
        success = false;
    }
    if (!success) {
        console.log("Origin hung. Relaunching...");
        await originSignIn();
        return;
    }
}
// #endregion
// #region Battlelog
class Battlelog extends EventEmitter {
    gameState: GameState;
    signedIn = false;
    browser!: puppeteer.Browser;
    blPage!: puppeteer.Page;
    constructor() {
        super();
        this.gameState = GameState.INIT;
        this.init();
    }
    async init(): Promise<void> {
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
    async login(email: string, password: string): Promise<boolean> {
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
    async joinServer(guid:string): Promise<boolean> {
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
    async leaveServer(): Promise<boolean> {
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
function wait(delay) {
    return new Promise(function (resolve) {
        setTimeout(resolve, delay);
    });
}
// Promisify ps.lookup
function findProcess(name: string) {
    return new Promise(function (resolve, reject) {
        ps.lookup({ command: name }, function (err, results) {
            if (err) {
                reject(err);
            }
            resolve(results[0]);
        });
    });
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
// #endregion
async function main() {
    await originSignIn();
    setInterval(originWatchdog, 30000);
    console.log("Initializing Battlelog.");
    battlelog = new Battlelog();
    battlelog.on("readyToLogin", async () => {
        // Keep getting gateway timeouts. This way, it tries until it logs in.
        let loggedIn = false;
        while(!loggedIn) {
            loggedIn = await battlelog.login(config.email, config.password);
        }
    });
    battlelog.on("loggedIn", async () => {
        console.log("Battlelog Ready.");
        serverInterface = new ServerInterface(controlServer!, authToken!, battlelog );
        setInterval(antiIdle, 120000);
    });
    battlelog.on("gameStateChange", async (launcherEvent: LauncherEvent, lastGameState: GameState) => {
        console.log(`${GameState[lastGameState]} -> ${GameState[battlelog.gameState]}`);
    });
}
main();