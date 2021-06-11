"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Packages
const chrome_remote_interface_1 = __importDefault(require("chrome-remote-interface"));
const os_1 = require("os");
const nodeWindows = __importStar(require("node-window-manager"));
const robot = __importStar(require("robotjs"));
const path_1 = __importDefault(require("path"));
const events_1 = __importDefault(require("events"));
const child_process_1 = __importDefault(require("child_process"));
const puppeteer_core_1 = __importDefault(require("puppeteer-core"));
const download_chromium_1 = __importDefault(require("download-chromium"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const ps_node_1 = __importDefault(require("ps-node"));
const fs_1 = __importDefault(require("fs"));
// Local Files
const protocol_json_1 = __importDefault(require("./resources/protocol.json"));
const config = JSON.parse(fs_1.default.readFileSync("./config.json", { "encoding": "utf-8" }));
// Global Constants
// TODO: MOVE THIS INTO ENV VARIABLE/CL FLAG: IDEALLY BOTH
let controlURL = process.argv.find(e => e.startsWith("--server="));
if (controlURL) {
    controlURL = "http://" + controlURL.split("=")[1];
}
else if (process.env["SeederServer"]) {
    controlURL = process.env["SeederServer"];
}
else {
    throw new Error("Seeder Server not defined.");
}
console.log(`Seeder Control Server set to ${controlURL}`);
// Global Variables
let currentDirective = "";
let contactFailure = false;
let battlelog;
let originChildProcess;
let originLaunched;
let signingIn = false;
// #region Origin
function originSignIn() {
    return __awaiter(this, void 0, void 0, function* () {
        if (signingIn)
            return;
        signingIn = true;
        originLaunched = false;
        // Find Origin.exe's PID and kill it.
        // If this is the first launch, and originChildProcess doesn't exist yet:
        if (!originChildProcess) {
            // findProcess is very inefficient/slow so we try and avoid it if at all possible.
            const originProcess = yield findProcess("Origin.exe");
            if (originProcess) {
                process.kill(originProcess.pid);
            }
        }
        else {
            originChildProcess.kill();
        }
        console.log("Relaunching Origin...");
        yield wait(250);
        // Launch it again!
        originChildProcess = child_process_1.default.spawn(`${process.env["ProgramFiles(x86)"]}\\Origin\\Origin.exe`, ["--remote-debugging-port=8081"]);
        console.log("Relaunched Origin. Waiting for Origin to finish starting...");
        yield wait(5000);
        // Initialize our CRI client.
        const debugOptions = {
            port: "8081",
        };
        let tabs;
        while (!tabs) {
            try {
                tabs = yield chrome_remote_interface_1.default.List(debugOptions);
            }
            catch (_a) {
                yield wait(1000);
                continue;
            }
        }
        let loginTab;
        while (!loginTab) {
            // Don't lock up the process
            yield wait(500);
            // List our tabs again
            tabs = yield chrome_remote_interface_1.default.List(debugOptions);
            // Look to see if we're already signed in. if so, break.
            if (tabs.find(element => element.url.includes("origin.com/usa")))
                break;
            // Look for our login tab.
            loginTab = tabs.find(element => element.url.includes("signin.ea.com"));
        }
        // If we need to login
        if (loginTab) {
            debugOptions.protocol = protocol_json_1.default;
            debugOptions.target = loginTab.webSocketDebuggerUrl;
            const client = yield chrome_remote_interface_1.default(debugOptions);
            yield client.Runtime.enable();
            console.log("Signing into Origin.");
            // TODO: Add error handling. Too much work at the moment.
            yield evalCode(client, `document.getElementById('email').value = '${config.email}`);
            yield evalCode(client, `document.getElementById('password').value = '${config.password}'`);
            yield evalCode(client, "document.getElementById('rememberMe').checked = true");
            yield wait(10);
            yield evalCode(client, "document.getElementById('logInBtn').click()");
            yield client.close();
            console.log("Now signed into Origin.");
        }
        else {
            console.log("Already signed into Origin.");
        }
        originLaunched = true;
        signingIn = false;
        return;
    });
}
function originWatchdog() {
    return __awaiter(this, void 0, void 0, function* () {
        // If we're currently launching Origin, return.
        if (!originLaunched)
            return;
        let success = true;
        try {
            // Check if Origin's frozen using the magic link.
            yield node_fetch_1.default("http://127.0.0.1:3215/ping", { timeout: 1000 });
        }
        catch (e) {
            success = false;
        }
        if (!success) {
            console.log("Origin hung. Relaunching...");
            yield originSignIn();
            return;
        }
    });
}
// #endregion
// #region Battlelog
class Battlelog extends events_1.default {
    constructor() {
        super();
        this.signedIn = false;
        this.gameState = GameState.INIT;
        this.init();
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            const downloadChromeOptions = {
                "revision": "884014",
                "installPath": path_1.default.join(process.cwd(), ".local-chromium"),
            };
            const exec = yield download_chromium_1.default(downloadChromeOptions);
            const puppeteerOptions = {
                "headless": true,
                "executablePath": exec,
            };
            this.browser = yield puppeteer_core_1.default.launch(puppeteerOptions);
            this.blPage = (yield this.browser.pages())[0];
            yield this.blPage.goto("https://battlelog.battlefield.com/bf4/");
            // Set up our event emitters for game state changes
            // TODO: Set up a setter for gameState and move emitters to there.
            this.blPage.on("console", (msg) => {
                let message;
                try {
                    message = JSON.parse(msg.text());
                }
                catch (_a) {
                    return;
                }
                if (message.length === 4) {
                    if ((typeof eventToState[message[2]]) !== "undefined") {
                        const lastGameState = this.gameState;
                        this.gameState = eventToState[message[2]];
                        const launcherEvent = {
                            eventInfo: message[0],
                            titleID: message[1],
                            launcherState: message[2],
                            personaID: message[3],
                        };
                        if (this.gameState !== lastGameState) {
                            this.emit("gameStateChange", launcherEvent, lastGameState);
                        }
                    }
                    else {
                        this.emit("unknownMessage", message);
                    }
                }
            });
            this.emit("readyToLogin");
        });
    }
    login(email, password) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.blPage.goto("https://accounts.ea.com/connect/auth?locale=en_US&state=bf4&redirect_uri=https%3A%2F%2Fbattlelog.battlefield.com%2Fsso%2F%3Ftokentype%3Dcode&response_type=code&client_id=battlelog&display=web%2Flogin");
            yield this.blPage.type("#email", email);
            yield this.blPage.type("#password", password);
            yield this.blPage.click("#btnLogin");
            return new Promise((resolve) => {
                this.blPage.once("load", () => __awaiter(this, void 0, void 0, function* () {
                    if ((yield this.blPage.evaluate(() => {
                        return document.getElementsByClassName("username");
                    })).length === 0) {
                        resolve(false);
                    }
                    else {
                        resolve(true);
                        this.emit("loggedIn");
                        this.gameState = GameState.IDLE;
                    }
                }));
            });
        });
    }
    joinServer(guid) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.blPage.goto(`https://battlelog.battlefield.com/bf4/servers/show/pc/${guid}`);
                yield this.blPage.addScriptTag({ path: path_1.default.join(__dirname, "resources/bleventhook.js") });
                yield this.blPage.click("[data-track=\"serverbrowser.server.join\"]");
            }
            catch (_a) {
                return false;
            }
            return true;
        });
    }
    leaveServer() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.blPage.evaluate("gamemanager.cancelGameLaunch(gamemanager.launcherState.currentGame);");
            }
            catch (_a) {
                return false;
            }
            return true;
        });
    }
}
var GameState;
(function (GameState) {
    GameState[GameState["INIT"] = 0] = "INIT";
    GameState[GameState["IDLE"] = 1] = "IDLE";
    GameState[GameState["RESERVING_SLOT"] = 2] = "RESERVING_SLOT";
    GameState[GameState["QUEUED"] = 3] = "QUEUED";
    GameState[GameState["LAUNCHING"] = 4] = "LAUNCHING";
    GameState[GameState["LOADING"] = 5] = "LOADING";
    GameState[GameState["IN_GAME"] = 6] = "IN_GAME";
    GameState[GameState["EXITING"] = 7] = "EXITING";
})(GameState || (GameState = {}));
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
function updateDirectives() {
    return __awaiter(this, void 0, void 0, function* () {
        // Get Directive
        let newGUID;
        try {
            newGUID = yield (yield node_fetch_1.default(`${controlURL}/instruct`)).text();
            contactFailure = false;
        }
        catch (e) {
            console.log("Connection to control server failed.");
            if (contactFailure) {
                currentDirective = "";
                if (gameStateToSeederState(battlelog.gameState) !== SeederState.IDLE) {
                    console.log("Connection to control server failed again. Shutting down until connection may be reestablished.");
                    battlelog.leaveServer();
                }
                return;
            }
            contactFailure = true;
            return;
        }
        if (currentDirective !== newGUID) {
            if ((newGUID === "") && (gameStateToSeederState(battlelog.gameState) !== SeederState.IDLE)) {
                console.log("Signal recieved to disconnect.");
                currentDirective = newGUID;
                yield battlelog.leaveServer();
                return;
            }
            console.log(`Changing servers from ${currentDirective} to ${newGUID}.`);
            yield battlelog.joinServer(newGUID);
            currentDirective = newGUID;
        }
        sendServerStatus();
    });
}
function sendServerStatus() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const body = { "seederID": os_1.hostname(), state: gameStateToSeederState(battlelog.gameState) };
            yield node_fetch_1.default(`${controlURL}/status`, {
                method: "post",
                body: JSON.stringify(body),
                headers: { "Content-Type": "application/json" },
            });
            return;
        }
        catch (e) {
            console.log("Connection to control server failed.");
            return;
        }
    });
}
function gameStateToSeederState(gameState) {
    switch (gameState) {
        case GameState.INIT:
            return SeederState.IDLE;
        case GameState.IDLE:
            return SeederState.IDLE;
        case GameState.EXITING:
            return SeederState.IDLE;
        case GameState.RESERVING_SLOT:
            return SeederState.JOINING;
        case GameState.QUEUED:
            return SeederState.JOINING;
        case GameState.LAUNCHING:
            return SeederState.JOINING;
        case GameState.LOADING:
            return SeederState.JOINING;
        case GameState.IN_GAME:
            return SeederState.IN_GAME;
    }
}
var SeederState;
(function (SeederState) {
    SeederState[SeederState["IDLE"] = 0] = "IDLE";
    SeederState[SeederState["JOINING"] = 1] = "JOINING";
    SeederState[SeederState["IN_GAME"] = 2] = "IN_GAME";
    SeederState[SeederState["ERROR"] = 3] = "ERROR";
})(SeederState || (SeederState = {}));
// #endregion
// #region Helpers
function evalCode(client, code) {
    return __awaiter(this, void 0, void 0, function* () {
        return (yield client.Runtime.evaluate({ "expression": code })).result.value;
    });
}
function wait(delay) {
    return new Promise(function (resolve) {
        setTimeout(resolve, delay);
    });
}
// Promisify ps.lookup
function findProcess(name) {
    return new Promise(function (resolve, reject) {
        ps_node_1.default.lookup({ command: name }, function (err, results) {
            if (err) {
                reject(err);
            }
            resolve(results[0]);
        });
    });
}
// #endregion
function antiIdle() {
    return __awaiter(this, void 0, void 0, function* () {
        if (battlelog.gameState !== GameState.IN_GAME)
            return;
        const windows = nodeWindows.windowManager.getWindows();
        let bf4Window;
        for (const window of windows) {
            if (window.getTitle() === "Battlefield 4") {
                bf4Window = window;
                break;
            }
        }
        if (!bf4Window)
            return;
        if (nodeWindows.windowManager.getActiveWindow().getTitle() !== "Battlefield 4") {
            bf4Window.restore();
            bf4Window.bringToTop();
            yield wait(1000);
        }
        robot.keyTap("space");
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        yield originSignIn();
        setInterval(originWatchdog, 30000);
        console.log("Initializing Battlelog.");
        battlelog = new Battlelog();
        battlelog.on("readyToLogin", () => __awaiter(this, void 0, void 0, function* () {
            // Keep getting gateway timeouts. This way, it tries until it logs in.
            let loggedIn = false;
            while (!loggedIn) {
                loggedIn = yield battlelog.login(config.email, config.password);
            }
        }));
        battlelog.on("loggedIn", () => __awaiter(this, void 0, void 0, function* () {
            console.log("Battlelog Ready. Getting directives from remote server...");
            yield updateDirectives();
            setInterval(updateDirectives, 30000);
            setInterval(antiIdle, 30000);
        }));
        battlelog.on("gameStateChange", (launcherEvent, lastGameState) => __awaiter(this, void 0, void 0, function* () {
            console.log(`${GameState[lastGameState]} -> ${GameState[battlelog.gameState]}`);
            if (gameStateToSeederState(lastGameState) !== gameStateToSeederState(battlelog.gameState)) {
                yield sendServerStatus();
            }
        }));
    });
}
main();
