// Packages
import EventEmitter from "events";
import fs from "fs";
const config = JSON.parse(fs.readFileSync("./config.json", {"encoding":"utf-8"}));
import buildConfig from "./buildconfig/config.js";
import { wait } from "./modules/util";
import OriginInterface from "./modules/OriginInterface";
import ServerInterface, { ServerData, bfGame } from "./modules/ServerInterface";
import Battlelog, { GameState } from "./modules/Battlelog";
import BattlefieldOne, { OneState } from "./modules/BattlefieldOne";
// Global Constants
const { controlServer, authToken } = buildConfig.getConfig();
// Global Variables
let battlelog:Battlelog;
let battlefieldOne:BattlefieldOne;
let serverInterface:ServerInterface;
let originInterface:OriginInterface;
async function main() {
    // Initialize OriginInterface
    console.log("Initializing Origin.");
    originInterface = new OriginInterface(config.email, config.password);
    await waitForEvent(originInterface, "ready");
    // Initialize Server Interface
    console.log("Initializing Server Interface.");
    serverInterface = new ServerInterface(controlServer!, authToken!);
    serverInterface.once("connected", () => {
        console.log("Server Interface connected.");
    });
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
        battlelog.on("gameStateChange", async (lastGameState: GameState) => {
            console.log(`[BF4] ${GameState[lastGameState]} -> ${GameState[battlelog.gameState]}`);
            serverInterface.updateBF4State(battlelog.gameState);
        });
        console.log("[BF4] Ready.");
    }
    // Initialize BattlefieldOne
    if (originInterface.hasBF1) {
        console.log("[BF1] Initializing BF1.");
        battlefieldOne = new BattlefieldOne();
        await waitForEvent(battlefieldOne, "ready");
        console.log("[BF1] Ready.");
        battlefieldOne.on("newState", (oldState:OneState) => {
            console.log(`[BF1] ${OneState[oldState]} -> ${OneState[battlefieldOne.state]}`);
            serverInterface.updateBF1State(battlefieldOne.state);
        });
        originInterface.on("bf1StatusChange", () => {
            battlefieldOne.state = originInterface.originOneState;
        });
        originInterface.on("gameClosed", () => {
            battlefieldOne.checkGame();
        });
    }
    serverInterface.on("newTarget", async (newGame:bfGame, newTarget:ServerData) => {
        if((newGame === "BF4") && originInterface.hasBF4 && battlelog) {
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
            await battlelog.joinServer(newTarget.guid);
            console.log(`[BF4] New target set to:\n${newTarget.name}\n${newTarget.guid}\nBy: ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
        }
        if (newGame === "BF1" && originInterface.hasBF1 && battlefieldOne) {
            serverInterface.updateBF1State(battlefieldOne.state);
            if (newTarget.guid === battlefieldOne.target.guid) return;
            battlefieldOne.target = newTarget;
            if (newTarget.guid) {
                console.log(`[BF1] New target set to:\n${newTarget.name}\n${newTarget.guid}\nBy: ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
            } else {
                console.log(`[BF1] Instructed to disconnect by user ${newTarget.user} at ${new Date(newTarget.timestamp).toLocaleTimeString()}`);
            }
        }
    });
    serverInterface.on("connected", () => {
        serverInterface.initTargets();
    });
    serverInterface.initTargets();
    setInterval(async () => {
        if (originInterface.hasBF4) {
            await battlelog.antiIdle();
        }
        if (originInterface.hasBF1) {
            await battlefieldOne.antiIdle();
        }
    }, 60000);
}
function waitForEvent(emitter:EventEmitter, eventName:string) {
    return new Promise((res) => {
        emitter.once(eventName, res);
    });
}
main();