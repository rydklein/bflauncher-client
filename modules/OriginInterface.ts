import child_process from "child_process";
import CRI from "chrome-remote-interface";
import EventEmitter from "events";
import fetch from "node-fetch";
import protocol from "../resources/protocol.json";
import { BFGame } from "./ServerInterface";
import * as util from "./util";
export default class OriginInterface extends EventEmitter {
    // If Origin is running AND accessable to the debugger.
    public originRunning = false;
    // If Origin is signed in to the proper account.
    public signedIn = false;
    // Origin Username
    public playerName!:string;
    // Private (self-explanatory)
    private email:string | null;
    private password:string | null;
    private shouldLogin:boolean;
    private originInstance!:child_process.ChildProcess;
    private originDebugger;
    private launchStampBF4:number | null = null;
    private launchStampBF1:number | null = null;
    private originBF1State:GameState = GameState.IDLE;
    private originBF4State:GameState = GameState.IDLE;
    private hasBF4 = false;
    private hasBF1 = false;
    constructor(logIn:boolean, email?:string, password?:string) {
        super();
        this.email = email || null;
        this.password = password || null;
        this.shouldLogin = logIn;
        this.init();
    }
    public hasGame(game:BFGame):boolean {
        if (game === "BF4") return this.hasBF4;
        if (game === "BF1") return this.hasBF1;
        throw new Error("Input was not BFGame.");
    }
    public getState(game:BFGame):GameState {
        if (game === "BF4") return this.originBF4State;
        if (game === "BF1") return this.originBF1State;
        throw new Error("Input was not BFGame.");
    }
    private setState(game:BFGame, newState:GameState):void {
        if (game === "BF4") this.originBF4State = newState;
        if (game === "BF1") this.originBF1State = newState;
    }
    private getLaunchStamp(game:BFGame):number | null {
        if (game === "BF4") return this.launchStampBF4;
        if (game === "BF1") return this.launchStampBF1;
        throw new Error("Input was not BFGame.");
    }
    private setLaunchStamp(game:BFGame, newStamp:number | null):void {
        if (game === "BF4") this.launchStampBF4 = newStamp;
        if (game === "BF1") this.launchStampBF1 = newStamp;
    }
    private async init() {
        await this.restartOrigin();
        if (!(await this.initOrigin())) {
            throw new Error("Error initializing Origin.");
        }
        // Get array of installed games
        this.playerName = await this.evalCode("Origin.user.originId()");
        // I'm so sorry to anyone reading this.
        // Problem: Each version of the game has an OID for each region. That's a lot of OIDs to log.
        // Solution:
        await this.evalCode(OriginInterface.callbackHell);
        let gameChecksDone;
        while(!gameChecksDone) {
            gameChecksDone = await this.evalCode("window.gameChecksDone");
            if (!gameChecksDone) await util.wait(100);
        }
        this.hasBF4 = (await this.evalCode("window.hasBF4")) || false;
        this.hasBF1 = (await this.evalCode("window.hasBF1")) || false;
        this.emit("ready");
        setInterval(this.statusPoller, 1500);
        // If we disconnect from Origin, restart it and reinitialize it.
        this.originDebugger.once("disconnect", async () => {
            console.log("[OI] Disconnected from Origin. Restarting...");
            await this.restartOrigin();
            await this.initOrigin();
        });
    }
    private restartOrigin = async ():Promise<void> => {
        // Find and restart Origin. Ensures that there are no artifacts left from last session in Origin Memory,
        // and ensures that we can access the debugger.
        if (!this.originInstance) {
            const originProcess = await util.findWindowByName("Origin");
            if (originProcess) {
                process.kill(originProcess.processId);
            }
        } else {
            this.originInstance.kill();
        }
        this.originRunning = false;
        this.originInstance = child_process.spawn(`${process.env["ProgramFiles(x86)"]}\\Origin\\Origin.exe`, ["-StartClientMinimized", "--remote-debugging-port=8081"], { detached:true });
        this.originRunning = true;
        return;
    }
    private initOrigin = async ():Promise<boolean> => {
        const debugOptions:any = {
            port: "8081",
        };
        const debugOptionsProtocol:any = {
            port: "8081",
            // Use an old protocol version (stored in ../resources/protocol.json.) Still not actually the correct version, but if it ain't broke...
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
            homePage = tabs.find(element => element.url.includes("origin.com/usa"));
            loginTab = tabs.find(element => element.url.includes("signin.ea.com"));
        }
        if (homePage) this.signedIn = true;
        if (loginTab) this.signedIn = false;
        // If we need to login
        if (loginTab) {
            debugOptionsProtocol.target = loginTab.webSocketDebuggerUrl;
            this.originDebugger = await CRI(debugOptionsProtocol);
            await this.originDebugger.Runtime.enable();
            await this.originDebugger.Page.enable();
            if (this.shouldLogin) {
                console.log("Signing into Origin.");
                // TODO: Add error handling. Too much work at the moment.
                await this.evalCode(`document.getElementById('email').value = '${this.email}'`);
                await this.evalCode(`document.getElementById('password').value = '${this.password}'`);
                await this.evalCode("document.getElementById('rememberMe').checked = true");
                await util.wait(10);
                this.evalCode("document.getElementById('logInBtn').click()");
                const loginSuccess = await Promise.race([util.waitForEvent(this.originDebugger, "Page.loadEventFired"), util.wait(5000)]);
                if (loginSuccess) {
                    this.signedIn = true;
                } else {
                    this.signedIn = false;
                    return false;
                }
            } else {
                console.log("[OI] Please sign in to Origin.");
                console.log("[OI] Exiting in 10 seconds...");
                await util.wait(10000);
                process.exit(0);
            }
            await this.originDebugger.close();
            delete debugOptionsProtocol.target;
        }
        while (!homePage) {
            await util.wait(250);
            tabs = await CRI.List(debugOptions);
            // Homepage has to exist since we already signed in successfully.
            homePage = tabs.find(element => element.url.includes("origin.com/usa"));
        }
        // Connect to the home page, wait for the page to load (or 5 seconds to elapse), and injects our listeners.
        debugOptionsProtocol.target = homePage.webSocketDebuggerUrl;
        this.originDebugger = await CRI(debugOptionsProtocol);
        await this.originDebugger.Page.enable();
        await Promise.race([this.originDebugger.Page.loadEventFired(), util.wait(5000)]);
        await this.originDebugger.Runtime.enable();
        // Sketchy workaround due to old version of Debug Tools
        // Detects game status changes and sets window.lastEvent to whatever it was.
        // Since we can't do much to interact with the debugger, we just have to poll it whenever we wanna check our status.
        await this.evalCode(OriginInterface.presenceHook);
        return true;
    }
    private async evalCode(code:string) {
        const output = await this.originDebugger.Runtime.evaluate({ "expression": code });
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
        try {
            lastEventBF1 = JSON.parse(await this.evalCode("JSON.stringify(window.lastEventBF1)"));
        } catch {
            lastEventBF1 = null;
        }
        try {
            lastEventBF4 = JSON.parse(await this.evalCode("JSON.stringify(window.lastEventBF4)"));
        } catch {
            lastEventBF4 = null;
        }
        const oldBF1State = this.originBF1State;
        const oldBF4State = this.originBF4State;
        if (lastEventBF1) {
            this.originBF1State = OriginInterface.presenceToGameState(lastEventBF1.gameActivity, this.originBF1State);
        }
        if (lastEventBF4) {
            this.originBF4State = OriginInterface.presenceToGameState(lastEventBF4.gameActivity, this.originBF4State);
        }
        // Used to only be called on game close detected but that was too buggy, so here we are...
        const bf4CloseCheck = this.checkClosed("BF4");
        const bf1CloseCheck = this.checkClosed("BF1");
        await bf4CloseCheck;
        await bf1CloseCheck;
        if (!(this.originBF1State === oldBF1State)) {
            this.emit("bf1StatusChange");
        }
        if (!(this.originBF4State === oldBF4State)) {
            this.emit("bf4StatusChange");
        }
    }).bind(this)
    private async checkClosed(game:BFGame) {
        // Check if either game is closed. If a game is detected to be closed but is supposed to be launching, give it 20 seconds, then check again.
        if (!util.isGameOpen(game)) { 
            if ((this.getState(game) === GameState.LAUNCHING)) {
                if (!this.getLaunchStamp(game)) {
                    this.setLaunchStamp(game, new Date().getTime());
                } else if ((new Date().getTime() - this.getLaunchStamp(game)!) >= 20000) {
                    this.setState(game, GameState.IDLE);
                    await this.evalCode(`window.lastEvent${game} = null`);
                }
            } else {
                this.setState(game, GameState.IDLE);
                await this.evalCode(`window.lastEvent${game} = null`);
                this.setLaunchStamp(game, null);
            }
        } else {
            this.setLaunchStamp(game, null);
        }
        return;
    }
    // Statics
    // Disgusting switches to get states from presence updates
    private static presenceToGameState = (newActivity:PresenceEvent, oldState:GameState):GameState => {
        if (!newActivity.joinable) {
            switch (newActivity.richPresence) {
                case "":
                case "In the menus": {
                    if (!((oldState === GameState.IDLE) || (oldState === GameState.LAUNCHING))) {
                        // If we go from non-idle to in-menu
                        return GameState.IDLE;
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
    // BF4 Master Title ID: 76889
    // BF1 Master Title ID: 190132
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
}
interface PresenceEvent {
    gamePresence:string;
    joinable:boolean;
    joinableInviteOnly:boolean;
    multiplayerId:string;
    productId:string;
    richPresence:string;
    title:string;
    twitchPresence:string;
}
