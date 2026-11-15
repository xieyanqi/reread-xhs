import { addSources, isDue, localDay, updateItem } from "./model.js";

const alarmName = "reread-check";
const noticeId = "reread-due";
let queue = Promise.resolve();

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

chrome.runtime.onMessage.addListener((input, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !["add", "convert", "checkin"].includes(input?.op)) return;
  run(async () => {
    const { items = [] } = await chrome.storage.local.get("items");
    const result = input.op === "add"
      ? addSources(items, input.entries)
      : updateItem(items.find(item => item.id === input.id), input);
    await chrome.storage.local.set({ items });
    return { ok: true, ...result };
  }).then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.items) run(refreshReminder);
});
run(ensureAlarm);
