import ps from "ps-node";
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