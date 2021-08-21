import EventEmitter from "events";
import { hostname } from "os";
import { io, Socket } from "socket.io-client";
import { GameState } from "./OriginInterface";
import * as util from "./util";
export default class ServerInterface extends EventEmitter {
    public currentGUID;
    private socket:Socket;
    private logger = new util.Logger("ServerInterface");
    private initialized = false;
    constructor (serverAddress:string, version:string, authToken:string, playerName:string) {
        super();
        const connectOptions = {
            "auth": {
                "hostname": hostname(),
                "playerName":playerName,
                "version":version,
                "token": authToken,
            },
            "autoConnect": false,
        };
        this.socket = io(`wss://${serverAddress}/ws/seeder`, connectOptions);
        // Socket Handlers
        this.socket.on("connect", () => {
            this.logger.log("Connected to Control Server.");
            this.emit("connected");
        });
        this.socket.on("disconnect", async (reason) => {
            this.emit("disconnected");
            this.logger.log(`Disconnected from Control Server. (${DisconnectReasons[reason]})`);
        });
        this.socket.on("newTarget", this.newTargetHandler);
        this.socket.on("restartOrigin", (author:string) => {
            this.logger.log(`Ordered to restart Origin\nBy: ${author} (${new Date().toLocaleString()})`);
            this.emit("restartOrigin");
        });
        this.socket.on("outOfDate", () => {
            this.logger.log("Client is out of date. Please update your client.");
            this.socket.disconnect();
        });
    }
    public connect = async ():Promise<void> => {
        if (this.initialized) return;
        const waitForConnect = util.waitForEvent(this, "connected", 60000);
        this.socket.connect();
        await waitForConnect; 
        const initTargets = await this.getTarget();
        this.newTargetHandler("BF4", initTargets["BF4"]);
        this.newTargetHandler("BF1", initTargets["BF1"]);
    }
    public updateState = (newGameState:GameState, game:BFGame):void => {
        this.socket.emit("gameStateUpdate", game, GameState[newGameState]);
    }
    private getTarget():Promise<Record<string, ServerData>> {
        return new Promise((resolve) => {
            this.socket.emit("getTarget", (newTarget:Record<string, ServerData>) => {
                resolve(newTarget);
            });
        });
    }
    private newTargetHandler = (async (game:BFGame, newTarget:ServerData) => {
        this.emit("newTarget", game, newTarget);
    }).bind(this);
}
enum DisconnectReasons {
    "io server disconnect",
    "io client disconnect",
    "ping timeout",
    "transport close",
    "transport error",
}
export type BFGame = "BF4" | "BF1";
export interface ServerData {
    "name":string | null,
    "guid":string | null,
    "user":string,
    "timestamp":number
}
