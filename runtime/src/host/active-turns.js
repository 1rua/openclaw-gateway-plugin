/** A cancellation receipt requires the SDK runner to settle after observing its signal. */
const turns = new Map();
const key = (accountId, generationId) => JSON.stringify([accountId, generationId]);
export const trackTurn = (accountId, generationId) => {
    const controller = new AbortController();
    let resolve;
    const settled = new Promise(done => { resolve = done; });
    const turn = { controller, settled };
    const id = key(accountId, generationId);
    turns.set(id, turn);
    return { signal: controller.signal, finish: () => {
            resolve();
            if (turns.get(id) === turn)
                turns.delete(id);
        } };
};
export const abortTrackedTurn = async (accountId, generationId) => {
    const turn = turns.get(key(accountId, generationId));
    if (!turn)
        return undefined;
    turn.controller.abort();
    let timer;
    try {
        return await Promise.race([turn.settled.then(() => "CANCELLED"),
            new Promise(resolve => { timer = setTimeout(() => resolve("OUTCOME_UNKNOWN"), 8000); })]);
    }
    finally {
        clearTimeout(timer);
    }
};
