import { hostname } from "os";
import EventEmitter from "events";
import { io, Socket } from "socket.io-client";
import { GameState } from "./OriginInterface";
export default class ServerInterface extends EventEmitter {
    public currentGUID;
    private socket:Socket;
    constructor (playerName:string, serverAddress:string, authToken:string) {
        super();
        this.socket = io(`wss://${serverAddress}/ws/seeder`, {  auth: {
            hostname: hostname(),
            token: authToken,
        }});
        // Socket Handlers
        this.socket.on("connect", async () => {
            this.emit("connected");
        });
        this.socket.on("newTarget", this.newTargetHandler);
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
    public updateState = (newGameState:GameState, game:BFGame):void => {
        this.socket.emit("gameStateUpdate", game, GameState[newGameState]);
    }
    public async initTargets():Promise<void> {
        const initTargets = await this.getTarget();
        this.newTargetHandler("BF4", initTargets["BF4"]);
        this.newTargetHandler("BF1", initTargets["BF1"]);
    }
}
export type BFGame = "BF4" | "BF1";
export interface ServerData {
    "name":string | null,
    "guid":string | null,
    "user":string,
    "timestamp":number
}
