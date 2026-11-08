import { StaticRegisterSearch } from "./register-search-engine.mjs?v=20261108-state-fixes";

let engine, release;
const requests = new Map();
const failure = error => ({ message: error?.message || "Не удалось выполнить поиск", code: error?.code || "SEARCH_DATA_ERROR" });
self.onmessage = async ({ data }) => {
  if (data?.type === "init") {
    try {
      if (engine || !/^[a-f0-9]{64}$/.test(data.release || "") || data.descriptor?.manifest?.sha256 !== data.release) throw new Error("Несовместимая версия поиска");
      release = data.release;
      engine = new StaticRegisterSearch({ descriptor: data.descriptor, root: data.root, districts: data.districts });
    } catch (error) { self.postMessage({ type: "fatal", release: data.release, error: failure(error) }); }
    return;
  }
  if (!engine || data?.release !== release) {
    self.postMessage({ type: "fatal", release, error: failure(new Error("Данные обновились. Обновите страницу.")) }); return;
  }
  if (data.type === "cancel") {
    requests.get(data.id)?.abort(); requests.delete(data.id); return;
  }
  if (data.type !== "search" || !Number.isSafeInteger(data.id) || data.id < 1 || requests.has(data.id)) return;
  if (requests.size >= 16) {
    self.postMessage({ type: "result", release, id: data.id, ok: false, error: failure(new Error("Дождитесь завершения поиска и повторите запрос.")) }); return;
  }
  const controller = new AbortController(); requests.set(data.id, controller);
  try {
    const result = await engine.search(data.query, data.district, { signal: controller.signal, suggest: data.suggest === true, preferDistrict: data.preferDistrict === true });
    controller.signal.throwIfAborted();
    if (requests.get(data.id) === controller) self.postMessage({ type: "result", release, id: data.id, ok: true, result });
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({ type: "result", release, id: data.id, ok: false, error: failure(error) });
  } finally { if (requests.get(data.id) === controller) requests.delete(data.id); }
};
