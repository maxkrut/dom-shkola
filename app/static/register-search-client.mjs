const messageError = payload => {
  const error = new Error(typeof payload?.message === "string" ? payload.message : "Поиск временно недоступен. Повторите запрос.");
  error.code = typeof payload?.code === "string" ? payload.code : "SEARCH_DATA_ERROR";
  return error;
};

export function createStaticSearchClient(descriptor, { root = new URL("../../", import.meta.url), districts, Worker: WorkerClass = globalThis.Worker, idleMs = 30000, timeoutMs = 30000 } = {}) {
  const release = descriptor?.manifest?.sha256;
  if (descriptor?.schema !== 1 || !/^[a-f0-9]{64}$/.test(release || "") || !Array.isArray(districts) || typeof WorkerClass !== "function"
      || !Number.isSafeInteger(idleMs) || idleMs < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error("Статический поиск недоступен");
  let worker, sequence = 0, lastMeasurement = null, idleTimer;
  const pending = new Map();
  const stop = (error = new DOMException("Поиск отменён", "AbortError")) => {
    clearTimeout(idleTimer); idleTimer = null;
    const current = worker; worker = null; current?.terminate();
    for (const request of pending.values()) { request.cleanup(); request.reject(error); }
    pending.clear();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (worker && !pending.size) {
      idleTimer = setTimeout(() => { if (!pending.size) stop(); }, idleMs);
      idleTimer.unref?.();
    }
  };
  function ensureWorker() {
    clearTimeout(idleTimer); idleTimer = null;
    if (worker) return worker;
    const current = new WorkerClass(new URL("./register-search-worker.mjs?v=20261108-state-fixes", import.meta.url), { type: "module", name: "school-address-search" });
    worker = current;
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      if (data?.release !== release) { stop(new Error("Данные обновились. Обновите страницу.")); return; }
      if (data.type === "fatal") { stop(messageError(data.error)); return; }
      const request = pending.get(data.id);
      if (data.type !== "result" || !request) return;
      pending.delete(data.id); request.cleanup();
      if (typeof data.ok !== "boolean") request.reject(new Error("Некорректный ответ поиска"));
      else if (!data.ok) request.reject(messageError(data.error));
      else if (!Array.isArray(data.result?.rows) || data.result.rows.length > 100) request.reject(new Error("Некорректный ответ поиска"));
      else { lastMeasurement = data.result.measurement; request.resolve(data.result.rows); }
      armIdle();
    };
    current.onerror = event => { event.preventDefault?.(); if (worker === current) stop(messageError()); };
    try { current.postMessage({ type: "init", release, descriptor, districts, root: new URL(root).href }); }
    catch (error) { stop(error); throw error; }
    return current;
  }
  return {
    search(query, district = "", signal, suggest = false, preferDistrict = false) {
      try { signal?.throwIfAborted(); } catch (error) { return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        let current;
        try { current = ensureWorker(); } catch (error) { reject(error); return; }
        const id = ++sequence;
        const cancel = () => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id); request.cleanup();
          try { current.postMessage({ type: "cancel", release, id }); } catch { stop(messageError()); }
          reject(signal.reason);
          armIdle();
        };
        const timer = setTimeout(() => {
          if (pending.has(id) && worker === current) stop(new Error("Поиск занял слишком много времени. Повторите запрос."));
        }, timeoutMs);
        pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } });
        signal?.addEventListener("abort", cancel, { once: true });
        try { current.postMessage({ type: "search", release, id, query, district, suggest, preferDistrict }); }
        catch (error) { stop(error); }
      });
    },
    dispose: stop,
    releaseIdle() { if (pending.size) return false; stop(); return true; },
    diagnostics: () => ({ workerCreated: Boolean(worker), pending: pending.size, lastMeasurement })
  };
}
