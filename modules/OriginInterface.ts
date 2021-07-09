import CRI from "chrome-remote-interface";
import EventEmitter from "events";
import child_process from "child_process";
import fetch from "node-fetch";
import protocol from "../resources/protocol.json";
import * as util from "./util";
export default class OriginInterface extends EventEmitter {
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
    public originBF1State:GameState = GameState.IDLE;
    public originBF4State:GameState = GameState.IDLE;
    // Private
    private email:string;
    private password:string;
    private originInstance!:child_process.ChildProcess;
    private originDebugger;
    private watchdogTimer;
    constructor(email:string, password:string) {
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
        this.playerName = await this.evalCode(this.originDebugger, "Origin.user.originId()");
        // I'm so sorry to anyone reading this.
        // Problem: Each version of the game has an OID for each region. That's a lot of OIDs to log.
        // Solution:
        await this.evalCode(this.originDebugger, OriginInterface.callbackHell);
        let gameChecksDone;
        while(!gameChecksDone) {
            gameChecksDone = await this.evalCode(this.originDebugger, "window.gameChecksDone");
            if (!gameChecksDone) await util.wait(100);
        }
        this.hasBF4 = (await this.evalCode(this.originDebugger, "window.hasBF1")) || false;
        this.hasBF1 = (await this.evalCode(this.originDebugger, "window.hasBF4")) || false;
        this.emit("ready");
        this.watchdogTimer = setInterval(this.originWatchdog, 30000);
        setInterval(this.statusPoller, 1000);
    }
    // Bind this to function so that when called from a timer, we can still refer to this.
    private restartOrigin = async ():Promise<void> => {
        if (!this.originInstance) {
            // findProcess is very inefficient/slow so we try and avoid it if at all possible.
            const originProcess: any = await util.findProcess("Origin.exe");
            if (originProcess) {
                process.kill(originProcess.pid);
            }
        } else {
            this.originInstance.kill();
        }
        this.originRunning = false;
        // Launch it again!
        this.originInstance = child_process.spawn(`${process.env["ProgramFiles(x86)"]}\\Origin\\Origin.exe`, ["-StartClientMinimized", "--remote-debugging-port=8081"], { detached:true });
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
                await util.wait(500);
                continue;
            }
        }
        let loginTab;
        let homePage;
        while (!(loginTab || homePage)) {
            // Don't lock up the process
            await util.wait(500);
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
            await this.evalCode(client, `document.getElementById('email').value = '${this.email}'`);
            await this.evalCode(client, `document.getElementById('password').value = '${this.password}'`);
            await this.evalCode(client, "document.getElementById('rememberMe').checked = true");
            await util.wait(10);
            // Resolve promise if the load event fires.
            const loggedInPromise = new Promise<boolean>((resolve) => {
                client.on("Page.loadEventFired", () => {
                    resolve(true);
                });
            });
            // If it's equal to 0, it worked. If not, uh oh.
            this.evalCode(client, "document.getElementById('logInBtn').click()");
            const loginSuccess = await Promise.race([loggedInPromise, util.wait(5000)]);
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
            await util.wait(250);
            tabs = await CRI.List(debugOptions);
            // Homepage has to exist since we already signed in successfully.
            homePage = tabs.find(element => element.url.includes("origin.com/usa"));
        }
        debugOptionsProtocol.target = homePage.webSocketDebuggerUrl;
        this.originDebugger = await CRI(debugOptionsProtocol);
        await this.originDebugger.Page.enable();
        await Promise.race([this.originDebugger.Page.loadEventFired(), util.wait(5000)]);
        await this.originDebugger.Runtime.enable();
        // Shitty workaround due to old version of Debug Tools
        // Detects game status changes and sets window.lastEvent to whatever it was.
        // Since we can't do much to interact with the debugger, we just have to poll it whenever we wanna check our status.
        await this.evalCode(this.originDebugger, OriginInterface.presenceHook);
        return true;
    }
    private async evalCode(client, code:string) {
        const output = await client.Runtime.evaluate({ "expression": code });
        return output.result.value;
    }
    // Timers
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
        let lastEventBF1;
        let lastEventBF4;
        let gameClosed;
        try {
            lastEventBF1 = JSON.parse(await this.evalCode(this.originDebugger, "JSON.stringify(window.lastEventBF1)"));
        } catch {
            lastEventBF1 = null;
        }
        try {
            lastEventBF4 = JSON.parse(await this.evalCode(this.originDebugger, "JSON.stringify(window.lastEventBF4)"));
        } catch {
            lastEventBF4 = null;
        }
        try {
            gameClosed = JSON.parse(await this.evalCode(this.originDebugger, "JSON.stringify(window.gameClosed)")) || false;
        } catch {
            gameClosed = false;
        }
        // Reset gameClosed
        const oldBF1State = this.originBF1State;
        const oldBF4State = this.originBF4State;
        if (lastEventBF1) {
            this.originBF1State = OriginInterface.presenceToGameState(lastEventBF1.gameActivity, this.originBF1State);
            if (!(this.originBF1State === oldBF1State)) {
                this.emit("bf1StatusChange");
            }
        }
        if (lastEventBF4) {
            this.originBF4State = OriginInterface.presenceToGameState(lastEventBF4.gameActivity, this.originBF4State);
            if (!(this.originBF4State === oldBF4State)) {
                this.emit("bf4StatusChange");
            }
        }
        if (gameClosed) {
            this.emit("gameClosed");
            await this.evalCode(this.originDebugger, "window.gameClosed = false");
        }
    }).bind(this)
    // Statics
    // Disgusting switches to get states from presence updates
    private static presenceToGameState = (newActivity: PresenceEvent, oldState: GameState) : GameState => {
        if (!newActivity.joinable) {
            switch (newActivity.richPresence) {
                case "":
                case "In the menus": {
                    if (!((oldState === GameState.IDLE) || (oldState === GameState.LAUNCHING))) {
                        // If we go from non-idle to in-menu
                        return GameState.DISCONNECTED;
                    } else {
                        // Otherwise, if we're going from idle to in-menu
                        return GameState.LAUNCHING;
                    }
                }
            }
        } else {
            switch (newActivity.richPresence) {
                case "In the menus": {
                    return GameState.JOINING;
                }
                case "": {
                    return oldState;
                }
                default: {
                    if (newActivity.richPresence.startsWith("MP:") || newActivity.richPresence.startsWith("Multiplayer:") ) {
                        return GameState.ACTIVE;
                    } else {
                        console.log("[OI] Unknown Presence Change.");
                        console.dir(newActivity);
                    }
                }
            }
        }
        return oldState;
    }
    // Cursed Code
    static callbackHell = `
        function callbackHell() {
            let processedGames = 0;
            Origin.client.games.requestGamesStatus().then((out) => {
                if (!out.refreshComplete) return callbackHell();
                for (const game of out.updatedGames) {
                    Origin.games.catalogInfo(game.productId).then((catInfo) => {
                        processedGames++;
                        if ((catInfo.masterTitleId == "76889") && (game.playable)) {
                            window.hasBF4 = true;
                        }
                        if ((catInfo.masterTitleId == "190132") && (game.playable)) {
                            window.hasBF1 = true;
                        }
                        if (processedGames == (out.updatedGames.length - 1)) window.gameChecksDone = true;
                    });
                }
            });
        }
        callbackHell();`
    static presenceHook = `
        Origin.events.on("xmppPresenceChanged", (gameEvent) => {
            if ((gameEvent.gameActivity.title === "")) {
                window.gameClosed = true;
            }
            if (gameEvent.gameActivity.title === "Battlefield™ 1") {
                window.lastEventBF1 = JSON.parse(JSON.stringify(gameEvent));
            }
            if (gameEvent.gameActivity.title.startsWith("Battlefield 4™")) {
                window.lastEventBF4 = JSON.parse(JSON.stringify(gameEvent));
            }
        });`
}
export enum GameState {
    "IDLE",
    "LAUNCHING",
    "JOINING",
    "ACTIVE",
    "DISCONNECTED"
}
interface PresenceEvent {
    gamePresence: string;
    joinable: boolean;
    joinableInviteOnly: boolean;
    multiplayerId: string;
    productId: string;
    richPresence: string;
    title: string;
    twitchPresence: string;
}
