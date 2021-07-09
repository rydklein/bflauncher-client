import ps from "ps-node";
import EventEmitter from "events";
export function wait(delay:number):Promise<void> {
    return new Promise(function (resolve) {
        setTimeout(resolve, delay);
    });
}
export function findProcess(name: string):Promise<Record<string, unknown>> {
    return new Promise(function (resolve, reject) {
        ps.lookup({ command: name }, function (err, results) {
            if (err) {
                reject(err);
            }
            resolve(results[0]);
        });
    });
}
export function waitForEvent(emitter:EventEmitter, eventName:string): any {
    return new Promise((res) => {
        emitter.once(eventName, res);
    });
}