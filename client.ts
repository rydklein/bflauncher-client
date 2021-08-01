// Packages
import fs from "fs";
import buildConfig from "./buildconfig/config.js";
import * as util from "./modules/util";
import OriginInterface from "./modules/OriginInterface";
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
}
async function main() {
    console.log("BadPylot's Seeder Control Client");
    console.log("// TODO: Add funny randomized sentences below the title line.");
    // Initialize OriginInterface
    originInterface = new OriginInterface((!!config.email), config.email, config.password);
    await util.waitForEvent(originInterface, "ready");
    // Initialize Server Interface
    serverInterface = new ServerInterface(originInterface.playerName, controlServer, authToken);
    if (originInterface.hasGame("BF4")) {
        bfFour = new BFController("BF4");
        await util.waitForEvent(bfFour, "ready");
        bfFour.on("newState", () => {
            serverInterface.updateState(bfFour.state, "BF4");
        });
        originInterface.on("bf4StatusChange", () => {
            bfFour.state = originInterface.getState("BF4");
        });
    }
    if (originInterface.hasGame("BF1")) {
        bfOne = new BFController("BF1");
        await util.waitForEvent(bfOne, "ready");
        bfOne.on("newState", () => {
            serverInterface.updateState(bfOne.state, "BF1");
        });
        originInterface.on("bf1StatusChange", () => {
            bfOne.state = originInterface.getState("BF1");
        });
    }
    serverInterface.on("newTarget", async (newGame:BFGame, newTarget:ServerData) => {
        if((newGame === "BF4") && originInterface.hasGame("BF4")) {
            serverInterface.updateState(bfFour.state, "BF4");
            if (newTarget.guid === bfFour.target.guid) return;
            bfFour.target = newTarget;
        }
        if (newGame === "BF1" && originInterface.hasGame("BF1")) {
            serverInterface.updateState(bfOne.state, "BF1");
            if (newTarget.guid === bfOne.target.guid) return;
            bfOne.target = newTarget;
        }
    });
    serverInterface.on("disconnected", () => {
        const emptyTarget = {
            "name":null,
            "guid":null,
            "user":"System",
            "timestamp":new Date().getTime(),
        };
        if (originInterface.hasGame("BF4")) {
            bfFour.target = emptyTarget;
        }
        if (originInterface.hasGame("BF1")) {
            bfOne.target = emptyTarget;
        }
    });
    setInterval(async () => {
        if (originInterface.hasGame("BF4")) {
            await bfFour.antiIdle();
        }
        if (originInterface.hasGame("BF1")) {
            await bfOne.antiIdle();
        }
    }, 45000);
    serverInterface.connect();
}

main();