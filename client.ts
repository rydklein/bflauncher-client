// Packages
import fs from "fs";
import buildConfig from "./buildconfig/config.js";
import version from "./resources/version.json";
import * as util from "./modules/util";
import OriginInterface, { GameState } from "./modules/OriginInterface";
import ServerInterface, { ServerData, BFGame } from "./modules/ServerInterface";
import BFController from "./modules/BFController";
// Global Constants
const { controlServer, authToken } = buildConfig.getConfig();
const logger = new util.Logger("Main");
const org = controlServer.split(".")[0].toUpperCase();
const title = `Seeder Control Client (${org}/v${version.version})`;
process.title = title;
// Global Variables
let bfFour:BFController;
let bfOne:BFController;
let serverInterface:ServerInterface;
let originInterface:OriginInterface;
let accountName;
let hasBF4;
let hasBF1;
let config:LauncherConfig;
// Types
interface LauncherConfig {
    // Login Info for Origin
    email?:string,
    password?:string,
    // Overrides in case information can't be fetched from Origin
    accountName?:string,
    hasBF4?:boolean,
    hasBF1?:boolean
    // Other overrides
    bypassOrigin?:boolean, // Not implemented yet
    noAntiIdle?:boolean,
}
try {
    config = JSON.parse(fs.readFileSync("./config.json", {"encoding":"utf-8"}));
} catch {
    config = {};
}
(async () => {
    logger.log(`BadPylot's ${title}`);
    logger.log(`This application automatically launches and manages BF4/BF1.\nRun this application while you are not at your computer to automatically seed ${org} servers.`);
    // Initialize OriginInterface
    originInterface = new OriginInterface((!!config.email), config.email, config.password);
    await util.waitForEvent(originInterface, "ready");
    accountName = originInterface.playerName || config.accountName;
    hasBF4 = originInterface.hasBF4 || config.hasBF4 || false;
    hasBF1 = originInterface.hasBF1 || config.hasBF1 || false;
    // Initialize Server Interface
    serverInterface = new ServerInterface(controlServer, version.version, authToken, originInterface.playerName, hasBF4, hasBF1);
    if (hasBF4) {
        bfFour = new BFController(BFGame.BF4, accountName);
        await util.waitForEvent(bfFour, "ready");
        bfFour.on("newState", () => {
            serverInterface.updateState(bfFour.state, BFGame.BF4);
        });
        originInterface.on("bf4StatusChange", () => {
            bfFour.state = originInterface.getState(BFGame.BF4);
        });
    }
    if (hasBF1) {
        bfOne = new BFController(BFGame.BF1, accountName);
        await util.waitForEvent(bfOne, "ready");
        bfOne.on("newState", () => {
            serverInterface.updateState(bfOne.state, BFGame.BF1);
        });
        originInterface.on("bf1StatusChange", () => {
            bfOne.state = originInterface.getState(BFGame.BF1);
        });
    }
    serverInterface.on("newTarget", async (newGame:BFGame, newTarget:ServerData) => {
        if((newGame === BFGame.BF4) && hasBF4) {
            serverInterface.updateState(bfFour.state, BFGame.BF4);
            bfFour.target = newTarget;
        }
        if (newGame === BFGame.BF1 && hasBF1) {
            serverInterface.updateState(bfOne.state, BFGame.BF1);
            bfOne.target = newTarget;
        }
    });
    serverInterface.on("connected", () => {
        if (hasBF4) serverInterface.updateState(bfFour.state, BFGame.BF4);
        if (hasBF1) serverInterface.updateState(bfOne.state, BFGame.BF1);
    });
    serverInterface.once("connected", () => {
        logger.log("Startup completed successfully. Waiting for instructions...");
    });
    serverInterface.on("disconnected", () => {
        const emptyTarget = {
            "name":null,
            "guid":null,
            "gameId":null,
            "user":"System",
            "timestamp":new Date().getTime(),
        };
        if (hasBF4) {
            bfFour.target = emptyTarget;
        }
        if (hasBF1) {
            bfOne.target = emptyTarget;
        }
    });
    serverInterface.on("restartOrigin", () => {
        if (!originInterface.debuggerConnected) return;
        originInterface.reloadOrigin();
    });
    if (!config.noAntiIdle) {
        setInterval(async () => {
            if (hasBF4) {
                await bfFour.antiIdle();
            }
            if (hasBF1) {
                await bfOne.antiIdle();
            }
        }, 60000);
    }
    serverInterface.connect();
})();