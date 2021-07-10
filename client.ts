// Packages
import fs from "fs";
import buildConfig from "./buildconfig/config.js";
import * as util from "./modules/util";
import OriginInterface, { GameState } from "./modules/OriginInterface";
import ServerInterface, { ServerData, BFGame } from "./modules/ServerInterface";
import BFController from "./modules/BFController";
// Global Constants
const { controlServer, authToken } = buildConfig.getConfig();
// Global Variables
let bfFour:BFController;
let bfOne:BFController;
let serverInterface:ServerInterface;
let originInterface:OriginInterface;
let config;
try {
    config = JSON.parse(fs.readFileSync("./config.json", {"encoding":"utf-8"}));
} catch {
    config = {};
    console.log("[INIT] No config detected. You must manually log in to Origin.");
}
async function main() {
    // Initialize OriginInterface
    console.log("[OI] Initializing Origin.");
    originInterface = new OriginInterface((!!config.email), config.email, config.password);
    await util.waitForEvent(originInterface, "ready");
    // Initialize Server Interface
    console.log("[SI] Initializing Server Interface.");
    serverInterface = new ServerInterface(controlServer!, authToken!);
    serverInterface.on("connected", () => {
        console.log("[SI] Server Interface connected.");
    });
    if (originInterface.hasBF4) {
        console.log("[BF4] Initializing.");
        bfFour = new BFController("BF4");
        await util.waitForEvent(bfFour, "ready");
        console.log("[BF4] Ready.");
        bfFour.on("newState", (oldState:GameState) => {
            console.log(`[BF4] ${GameState[oldState]} -> ${GameState[bfFour.state]}`);
            serverInterface.updateState(bfFour.state, "BF4");
        });
        originInterface.on("bf4StatusChange", () => {
            bfFour.state = originInterface.originBF4State;
        });
        originInterface.on("gameClosed", () => {
            bfFour.checkGame();
        });
        console.log("[BF4] Ready.");
    }
    // Initialize bfOne
    if (originInterface.hasBF1) {
        console.log("[BF1] Initializing.");
        bfOne = new BFController("BF1");
        await util.waitForEvent(bfOne, "ready");
        console.log("[BF1] Ready.");
        bfOne.on("newState", (oldState:GameState) => {
            console.log(`[BF1] ${GameState[oldState]} -> ${GameState[bfOne.state]}`);
            serverInterface.updateState(bfOne.state, "BF1");
        });
        originInterface.on("bf1StatusChange", () => {
            bfOne.state = originInterface.originBF1State;
        });
        originInterface.on("gameClosed", () => {
            bfOne.checkGame();
        });
    }
    serverInterface.on("newTarget", async (newGame:BFGame, newTarget:ServerData) => {
        if((newGame === "BF4") && originInterface.hasBF4 && bfFour) {
            serverInterface.updateState(bfFour.state, "BF4");
            if (newTarget.guid === bfFour.target.guid) return;
            bfFour.target = newTarget;
        }
        if (newGame === "BF1" && originInterface.hasBF1 && bfOne) {
            serverInterface.updateState(bfOne.state, "BF1");
            if (newTarget.guid === bfOne.target.guid) return;
            bfOne.target = newTarget;
        }
        if (newTarget.guid) {
            console.log(`[${newGame}] New target set to:\n${newTarget.name}\n${newTarget.guid}\nBy: ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
        } else {
            console.log(`[${newGame}] Instructed to disconnect by user ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
        }
    });
    serverInterface.on("connected", () => {
        serverInterface.initTargets();
    });
    serverInterface.initTargets();
    setInterval(async () => {
        if (originInterface.hasBF4) {
            await bfFour.antiIdle();
        }
        if (originInterface.hasBF1) {
            await bfOne.antiIdle();
        }
    }, 60000);
}

main();