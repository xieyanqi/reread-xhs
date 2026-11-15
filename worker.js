import { isCollectionUrl, scanPage } from "./scan.js";
import { uncollect } from "./uncollect.js";
import { addSources, isDue, localDay, source, updateItem } from "./model.js";

const alarmName = "reread-check";
const noticeId = "reread-due";
let queue = Promise.resolve();
const removals = new Map();
let scanStep;

function run(task) {
  const operation = queue.then(task);
  queue = operation.catch(console.error);
  return operation;
}

async function refreshReminder() {
  const { items = [], notifiedOn = "" } = await chrome.storage.local.get(["items", "notifiedOn"]);
  const today = localDay();
  const due = items.filter(item => isDue(item, today));
  await chrome.action.setBadgeBackgroundColor({ color: "#9A3435" });
  await chrome.action.setBadgeText({ text: due.length > 99 ? "99+" : String(due.length || "") });
  if (!due.length) {
    await chrome.notifications.clear(noticeId);
    return;
  }
  if (notifiedOn !== today && await chrome.notifications.getPermissionLevel() === "granted") {
    const actions = due.filter(item => item.kind === "action").length;
    await chrome.notifications.create(noticeId, {
      type: "basic",
      iconUrl: "icons/128.png",
      title: "拾读 · 有收藏待回看",
      message: `有 ${due.length - actions} 条笔记和 ${actions} 条行动到期。点这里记录进展。`
    });
    await chrome.storage.local.set({ notifiedOn: today });
  }
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(alarmName))) {
    await chrome.alarms.create(alarmName, { periodInMinutes: 15 });
  }
}

function start() {
  run(async () => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await ensureAlarm();
    await refreshReminder();
  });
}

chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === alarmName) run(refreshReminder);
});
chrome.notifications.onClicked.addListener(id => {
  if (id === noticeId) {
    chrome.tabs.create({ url: chrome.runtime.getURL("index.html#due") }).catch(console.error);
    chrome.notifications.clear(id).catch(console.error);
  }
});

function removeFromCollection(id) {
  if (removals.has(id)) return removals.get(id);
  const operation = (async () => {
    const { items = [] } = await chrome.storage.local.get("items");
    const item = items.find(entry => entry.id === id);
    if (!item || item.favoriteRemoved) throw new Error("这条记录已移出复读。");
    const outcome = await uncollect(chrome, item);
    await run(async () => {
      const { items = [], excluded = [] } = await chrome.storage.local.get(["items", "excluded"]);
      const index = items.findIndex(entry => entry.id === id);
      const entry = items[index];
      if (entry?.body || entry?.history.length) {
        entry.favoriteRemoved = true;
        entry.status = "closed";
        entry.due = "";
      } else if (entry) {
        items.splice(index, 1);
      }
      if (!excluded.includes(id)) excluded.push(id);
      await chrome.storage.local.set({ items, excluded });
    });
    return { outcome };
  })().finally(() => removals.delete(id));
  removals.set(id, operation);
  return operation;
}

async function changeItems(input) {
  const { items = [], excluded = [] } = await chrome.storage.local.get(["items", "excluded"]);
  let result;
  if (input.op === "add") {
    const blocked = new Set(excluded);
    let skipped = 0;
    const entries = input.entries.filter(entry => {
      const id = source(entry.url)?.id;
      if (!blocked.has(id)) return true;
      if (input.collection) {
        skipped += 1;
        return false;
      }
      blocked.delete(id);
      const archived = items.find(item => item.id === id && item.favoriteRemoved);
      if (archived) {
        delete archived.favoriteRemoved;
        if (archived.kind !== "archived") archived.status = "open";
      }
      return true;
    });
    result = { ...addSources(items, entries), skipped };
    await chrome.storage.local.set({ items, excluded: [...blocked] });
  } else {
    updateItem(items.find(item => item.id === input.id), input);
    await chrome.storage.local.set({ items });
  }
  return result;
}

async function beginScan(input) {
  const tab = await chrome.tabs.get(input.tabId);
  if (!tab.url || !isCollectionUrl(tab.url)) throw new Error("请先打开「我的主页 → 收藏 → 笔记」。");
  const scanTab = await chrome.tabs.create({ url: tab.url, windowId: tab.windowId, active: true });
  return run(async () => {
    const scan = {
      id: crypto.randomUUID(), tabId: scanTab.id, url: tab.url, started: new Date().toISOString(),
      expected: null, lastTotal: null, rows: [], unique: 0, stop: ""
    };
    await chrome.storage.local.set({ scan });
    return { stop: "" };
  });
}

async function runScanStep() {
  const { scan } = await chrome.storage.local.get("scan");
  if (!scan) throw new Error("请从头开始一次扫描。");
  const offset = scan.rows.length;
  let result;
  try {
    const tab = await chrome.tabs.get(scan.tabId);
    if (tab.status === "loading" && (!tab.url || tab.url === "about:blank" || tab.url === scan.url)) {
      return { stop: "loading" };
    }
    if (tab.url !== scan.url) throw new Error("Collection tab closed or changed");
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: scan.tabId }, world: "MAIN", func: scanPage,
      args: [scan.url, offset, scan.rows[0]?.id, scan.rows.at(-1)?.id]
    });
    result = frame?.result || { stop: "unavailable" };
  } catch {
    result = { stop: "tab-changed" };
  }

  return run(async () => {
    const { scan: current, items = [], excluded = [] } = await chrome.storage.local.get(["scan", "items", "excluded"]);
    if (current?.id !== scan.id) return { stop: "restarted" };
    if (Number.isSafeInteger(result.total) && result.total >= 0) {
      current.expected ??= result.total;
      current.lastTotal = result.total;
    }
    const blocked = new Set(excluded);
    const seen = new Set(current.rows.map(row => row.id));
    const entries = [];
    for (const row of result.rows || []) {
      const parsed = source(row.url);
      const valid = parsed && parsed.id === row.id;
      const duplicate = valid && seen.has(row.id);
      if (valid && !duplicate) {
        seen.add(row.id);
        current.unique++;
        if (!blocked.has(row.id)) entries.push(row);
      }
      current.rows.push({ id: valid ? row.id : "", title: row.title, duplicate: Boolean(duplicate) });
    }
    if (entries.length) addSources(items, entries);
    current.stop = result.stop;
    const values = { scan: current };
    if (entries.length) values.items = items;
    await chrome.storage.local.set(values);
    return { stop: result.stop };
  });
}

function advanceScan() {
  scanStep ??= runScanStep().finally(() => { scanStep = null; });
  return scanStep;
}

chrome.runtime.onMessage.addListener((input, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !["add", "convert", "checkin", "uncollect", "scan-start", "scan-step"].includes(input?.op)) return;
  const operations = {
    uncollect: () => removeFromCollection(input.id),
    "scan-start": () => beginScan(input),
    "scan-step": advanceScan
  };
  const operation = operations[input.op]?.() ?? run(() => changeItems(input));
  operation.then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.items) run(refreshReminder);
});
run(ensureAlarm);
