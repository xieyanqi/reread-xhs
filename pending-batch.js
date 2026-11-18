export async function processPendingBatch(ids, { process, canContinue, onProgress, now = Date.now }) {
  const state = { total: ids.length, completed: 0, remainingMs: null };
  let processingMs = 0;
  for (const id of ids) {
    if (!canContinue()) return { ...state, stopped: true };
    onProgress(state);
    const start = now();
    try {
      const processed = await process(id);
      if (!processed) return { ...state, stopped: true };
    } catch (error) {
      return { ...state, stopped: true, error: error.message };
    }
    processingMs += Math.max(0, now() - start);
    state.completed++;
    state.remainingMs = processingMs / state.completed * (state.total - state.completed);
    onProgress(state);
  }
  return { ...state, stopped: false };
}
