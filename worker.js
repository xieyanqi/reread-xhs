import { uncollect } from "./uncollect.js";
import { addSources, isDue, localDay, source, updateItem } from "./model.js";

const alarmName = "reread-check";
const noticeId = "reread-due";
let queue = Promise.resolve();
const removals = new Map();

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

chrome.runtime.onMessage.addListener((input, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !["add", "convert", "checkin", "uncollect"].includes(input?.op)) return;
  const operation = input.op === "uncollect" ? removeFromCollection(input.id) : run(() => changeItems(input));
  operation.then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.items) run(refreshReminder);
});
run(ensureAlarm);
