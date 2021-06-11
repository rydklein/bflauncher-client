/* eslint-disable no-undef */
const eventsToListenForDbg = ["error.anotherGameRunning", "error.gameNeedsManualKill", "error.gameCrashed", "error.generic", "gameStatus", "error.gameNotLaunched", "error.gameNotResponding"];
const eventsToListenFor = ["gameStatus"];
eventsToListenFor.forEach((eventToRegister) => {
    launcher.registerForEvent(eventToRegister, eventHandler);
});
function eventHandler() {
    console.log(JSON.stringify(Array.from(arguments)));
}