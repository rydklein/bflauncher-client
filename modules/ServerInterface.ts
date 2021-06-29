import { hostname } from "os";
import EventEmitter from "events";
import { io, Socket } from "socket.io-client";
import { OneState } from "./BattlefieldOne";
import { GameState } from "./Battlelog";
export default class ServerInterface extends EventEmitter {
    private socket:Socket;
    public currentGUID;
    constructor (serverAddress:string, authToken:string) {
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
    private newTargetHandler = (async (game:bfGame, newTarget:ServerData) => {
        this.emit("newTarget", game, newTarget);
    }).bind(this);
    public updateBF4State = (newGameState:GameState):void => {
        this.socket.emit("gameStateUpdate", GameState[newGameState]);
    }
    public updateBF1State = (newOneState:OneState):void => {
        this.socket.emit("oneStateUpdate", OneState[newOneState]);
    }
    public async initTargets():Promise<void> {
        const initTargets = await this.getTarget();
        this.newTargetHandler("BF4", initTargets["BF4"]);
        this.newTargetHandler("BF1", initTargets["BF1"]);
    }
}
export type ServerData = {
    "name":string | null,
    "guid":string | null,
    "user":string,
    "timestamp":number
}
export type bfGame = "BF4" | "BF1";