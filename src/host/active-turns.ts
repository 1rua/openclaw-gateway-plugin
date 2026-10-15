/** A cancellation receipt requires the SDK runner to settle after observing its signal. */
const turns = new Map<string, { controller: AbortController; settled: Promise<void> }>();
const key = (accountId: string, generationId: string) => JSON.stringify([accountId, generationId]);
export const trackTurn = (accountId: string, generationId: string) => {
  const controller = new AbortController();
  let resolve!: () => void;
  const settled = new Promise<void>(done => { resolve = done; });
  const turn = { controller, settled };
  const id = key(accountId, generationId);
  turns.set(id, turn);
  return { signal: controller.signal, finish: () => {
    resolve();
    if (turns.get(id) === turn) turns.delete(id);
  } };
};
export const abortTrackedTurn = async (accountId: string, generationId: string): Promise<"CANCELLED" | "OUTCOME_UNKNOWN" | undefined> => {
  const turn = turns.get(key(accountId, generationId));
  if (!turn) return undefined;
  turn.controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([turn.settled.then(() => "CANCELLED" as const),
      new Promise<"OUTCOME_UNKNOWN">(resolve => { timer = setTimeout(() => resolve("OUTCOME_UNKNOWN"), 8000); })]);
  } finally { clearTimeout(timer); }
};
