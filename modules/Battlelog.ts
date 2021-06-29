import * as nodeWindows from "node-window-manager";
import * as robot from "robotjs";
import path from "path";
import EventEmitter from "events";
import puppeteer from "puppeteer-core";
import downloadChrome from "download-chromium";
import { ServerData } from "./ServerInterface";
import { wait } from "./util";
export default class Battlelog extends EventEmitter {
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
                    if (this.gameState !== lastGameState) {
                        this.emit("gameStateChange", lastGameState);
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
        await wait(1000);
        robot.keyTap("space");
        await wait(500);
        bf4Window.minimize();
        await wait(1000);
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
export enum GameState {
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