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
    constructor (serverAddress:string, version:string, authToken:string, playerName:string, hasBF4:boolean, hasBF1:boolean) {
        super();
        const connectOptions = {
            "query": {
                "hostname": hostname(),
                "playerName":playerName,
                "version":version,
                "token": authToken,
                "hasBF4":hasBF4.toString(),
                "hasBF1":hasBF1.toString(),
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
    }
    public updateState = (newGameState:GameState, game:BFGame):void => {
        this.socket.emit("gameStateUpdate", game, newGameState);
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
export enum BFGame {
    "BF4",
    "BF1",
}
export interface ServerData {
    "name":string | null,
    "guid":string | null,
    "gameId":string | null;
    "user":string,
    "timestamp":number
}