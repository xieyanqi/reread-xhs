import { batchLimit, batchIds, batchItems, pendingUncollectInBatch, restrictedMessage, siteRestricted } from "./batch.js";
import { canUncollect, protectedItem, stages } from "./cleanup-model.js";
import { collectionProfile, isCollectionUrl, scanPage } from "./scan.js";
import { openOriginal, uncollect } from "./uncollect.js";
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

function assertBatch(scan, id) {
  if (scan && !batchIds(scan).has(id)) throw new Error("这条笔记不在当前批次。");
}

async function observeRestriction(tabId) {
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId }, func: siteRestricted
  });
  return frame?.result === true;
}

async function recordRestriction() {
  await chrome.storage.local.set({ siteBlocked: true });
}

async function siteAction(job) {
  if ((await chrome.storage.local.get("siteBlocked")).siteBlocked) throw new Error(restrictedMessage);
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (current?.url && current.status === "complete" &&
      /^https:\/\/(?:www\.|m\.)?xiaohongshu\.com\//.test(current.url) &&
      await observeRestriction(current.id).catch(() => false)) {
    await recordRestriction();
    throw new Error(restrictedMessage);
  }
  try {
    return await job();
  } catch (error) {
    if (error.code === "restricted") await recordRestriction();
    throw error;
  }
}

async function resumeSite(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isCollectionUrl(tab.url) || tab.status !== "complete") {
    throw new Error("请按小红书提示处理限制，等收藏笔记页能正常显示，再点击这里。");
  }
  if (await observeRestriction(tab.id)) throw new Error(restrictedMessage);
  await chrome.storage.local.set({ siteBlocked: false });
}

async function refreshReminder() {
  const { items = [], notifiedOn = "", scan } = await chrome.storage.local.get(["items", "notifiedOn", "scan"]);
  const today = localDay();
  const due = (scan ? batchItems(items, scan) : items).filter(item => isDue(item, today));
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

function removeFromCollection(id, rejectIfProtected = false, fromQueue = false) {
  if (removals.has(id)) return removals.get(id);
  if (removals.size) return Promise.reject(new Error("正在处理另一条笔记，请等它完成。"));
  const operation = (async () => {
    const { items = [], scan, pendingUncollect = [] } =
      await chrome.storage.local.get(["items", "scan", "pendingUncollect"]);
    assertBatch(scan, id);
    if (fromQueue) {
      const current = pendingUncollectInBatch(pendingUncollect, scan)[0];
      if (current?.id !== id) throw new Error("待取消名单已更新，请确认当前这一条。");
      rejectIfProtected = !current.includeProtected;
    }
    const item = items.find(entry => entry.id === id);
    if (!item || item.favoriteRemoved) throw new Error("这条记录已移出复读。");
    if (rejectIfProtected && protectedItem(item)) throw new Error("这条帖子已有笔记或行动，请重新核对名单。");
    const outcome = await siteAction(() => uncollect(chrome, item));
    await run(async () => {
      const { items = [], excluded = [], pendingUncollect = [] } =
        await chrome.storage.local.get(["items", "excluded", "pendingUncollect"]);
      const index = items.findIndex(entry => entry.id === id);
      const entry = items[index];
      if (entry?.body || entry?.history.length) {
        entry.favoriteRemoved = true;
        delete entry.reviewRemoved;
        entry.status = "closed";
        entry.due = "";
      } else if (entry) {
        items.splice(index, 1);
      }
      if (!excluded.includes(id)) excluded.push(id);
      await chrome.storage.local.set({
        items, excluded, pendingUncollect: pendingUncollect.filter(entry => entry.id !== id)
      });
    });
    return { outcome };
  })().finally(() => removals.delete(id));
  removals.set(id, operation);
  return operation;
}

async function changeItems(input) {
  const { items = [], excluded = [], scan } = await chrome.storage.local.get(["items", "excluded", "scan"]);
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
      const archived = items.find(item => item.id === id && (item.favoriteRemoved || item.reviewRemoved));
      if (archived) {
        delete archived.favoriteRemoved;
        delete archived.reviewRemoved;
        if (archived.kind !== "archived") archived.status = "open";
      }
      return true;
    });
    result = { ...addSources(items, entries), skipped };
    await chrome.storage.local.set({ items, excluded: [...blocked] });
  } else {
    assertBatch(scan, input.id);
    updateItem(items.find(item => item.id === input.id), input);
    await chrome.storage.local.set({ items });
  }
  return result;
}

async function beginScan(input) {
  return run(async () => {
    const { scan: previous, siteBlocked } = await chrome.storage.local.get(["scan", "siteBlocked"]);
    if (input.op === "scan-next" && previous) {
      const next = (previous.batchStart ?? 0) + batchLimit;
      if (next < previous.rows.length) {
        previous.batchStart = next;
        await chrome.storage.local.set({ scan: previous });
        return { offline: true };
      }
      if (previous.stop === "site-end" || next !== previous.rows.length) {
        throw new Error("当前批次尚未扫满，或小红书已经返回了末页。");
      }
    }
    if (siteBlocked) throw new Error(restrictedMessage);
    const tab = await chrome.tabs.get(input.tabId);
    if (!isCollectionUrl(tab.url)) {
      if (tab.url && /^https:\/\/(?:www\.|m\.)?xiaohongshu\.com\//.test(tab.url) && await observeRestriction(tab.id)) {
        await recordRestriction();
        throw new Error(restrictedMessage);
      }
      throw new Error("请先打开「我的主页 → 收藏 → 笔记」。");
    }
    if (input.op === "scan-next" && previous) {
      if (collectionProfile(previous.url) !== collectionProfile(tab.url)) throw new Error("请打开原来的收藏页再扫下一批。");
      previous.batchStart = previous.rows.length;
      previous.tabId = tab.id;
      previous.stop = "";
      await chrome.storage.local.set({ scan: previous });
    } else {
      const scan = {
        id: crypto.randomUUID(), tabId: tab.id, url: tab.url, started: new Date().toISOString(),
        expected: null, lastTotal: null, rows: [], unique: 0, batchStart: 0, stop: ""
      };
      await chrome.storage.local.set({ scan });
    }
    return { offline: false };
  });
}

async function runScanStep() {
  const { scan, siteBlocked } = await chrome.storage.local.get(["scan", "siteBlocked"]);
  if (siteBlocked) throw new Error(restrictedMessage);
  if (!scan) throw new Error("请从头开始一次扫描。");
  const offset = scan.rows.length;
  const remaining = batchLimit - (offset - (scan.batchStart ?? 0));
  if (remaining <= 0) return { stop: "batch-end" };
  let tab;
  let result;
  try {
    tab = await chrome.tabs.get(scan.tabId);
  } catch {
    result = { stop: "tab-closed" };
  }
  if (tab?.status === "loading") return { stop: "loading" };
  if (tab && collectionProfile(tab.url, true) !== collectionProfile(scan.url)) {
    const path = tab.url ? new URL(tab.url).pathname : "";
    let restricted = false;
    if (tab.url && /^https:\/\/(?:www\.|m\.)?xiaohongshu\.com\//.test(tab.url)) {
      restricted = await observeRestriction(tab.id).catch(() => false);
    }
    result = { stop: restricted ? "restricted" : /login|captcha|verify/i.test(path) ? "needs-site-access" : "not-collection" };
  }
  if (!result) {
    try {
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId: scan.tabId }, world: "MAIN", func: scanPage,
        args: [scan.url, offset, scan.rows[0]?.id ?? null, scan.rows.at(-1)?.id ?? null, Math.min(150, remaining)]
      });
      result = frame?.result || { stop: "unavailable" };
    } catch (error) {
      if (/frame.*(?:removed|navigat)|navigat.*frame/i.test(error.message)) return { stop: "loading" };
      result = { stop: /permission|access/i.test(error.message) ? "site-permission" : "script-error" };
    }
  }
  if (result.stop === "restricted") await recordRestriction();
  if (result.stop === "catching-up") return { stop: "catching-up", loaded: result.loaded };

  return run(async () => {
    const { scan: current, items = [], excluded = [] } = await chrome.storage.local.get(["scan", "items", "excluded"]);
    if (current?.id !== scan.id || current.batchStart !== scan.batchStart) return { stop: "restarted" };
    if (Number.isSafeInteger(result.total) && result.total >= 0) {
      current.expected ??= result.total;
      current.lastTotal = result.total;
    }
    const blocked = new Set(excluded);
    const seen = new Set(current.rows.map(row => row.id));
    const entries = [];
    for (const row of (result.rows || []).slice(0, remaining)) {
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
    current.stop = current.rows.length - (current.batchStart ?? 0) >= batchLimit && result.stop !== "site-end" ? "batch-end" : result.stop;
    const values = { scan: current };
    if (entries.length) values.items = items;
    await chrome.storage.local.set(values);
    return { stop: current.stop };
  });
}

function advanceScan() {
  scanStep ??= runScanStep().finally(() => { scanStep = null; });
  return scanStep;
}

async function cleanupDecision(input) {
  const { cleanupPreferences = {} } = await chrome.storage.local.get("cleanupPreferences");
  if (input.decision === "topic") {
    cleanupPreferences.topics = [...new Set([...(cleanupPreferences.topics || []), input.id])];
  } else if (input.decision === "keep") {
    cleanupPreferences.kept = [...new Set([...(cleanupPreferences.kept || []), input.id])];
  } else if (input.decision === "skip" && stages.includes(input.stage)) {
    cleanupPreferences.skipped ??= {};
    cleanupPreferences.skipped[input.stage] = [
      ...new Set([...(cleanupPreferences.skipped[input.stage] || []), input.id])
    ];
  } else {
    throw new Error("无法保存清理决定。");
  }
  await chrome.storage.local.set({ cleanupPreferences });
  return { cleanupPreferences };
}

async function enqueueUncollect(entries) {
  const { items = [], scan, pendingUncollect = [] } =
    await chrome.storage.local.get(["items", "scan", "pendingUncollect"]);
  const itemsById = new Map(batchItems(items, scan).map(item => [item.id, item]));
  const queued = new Set(pendingUncollect.map(entry => entry.id));
  const failed = [];
  let added = 0;
  for (const { id, includeProtected } of entries) {
    const item = itemsById.get(id);
    if (!item || item.status !== "open" || item.favoriteRemoved || !canUncollect(item) ||
        (protectedItem(item) && !includeProtected)) {
      failed.push(id);
      continue;
    }
    if (queued.has(id)) continue;
    queued.add(id);
    pendingUncollect.push({ id, includeProtected: Boolean(includeProtected) });
    added++;
  }
  if (added) await chrome.storage.local.set({ pendingUncollect });
  return { added, failed };
}

async function dropPendingUncollect(id) {
  if (removals.has(id)) throw new Error("这条笔记正在处理，请等它完成。");
  const { scan, pendingUncollect = [] } = await chrome.storage.local.get(["scan", "pendingUncollect"]);
  assertBatch(scan, id);
  await chrome.storage.local.set({ pendingUncollect: pendingUncollect.filter(entry => entry.id !== id) });
}

async function moveOutOfReview(input) {
  const { items = [], excluded = [], scan, pendingUncollect = [] } =
    await chrome.storage.local.get(["items", "excluded", "scan", "pendingUncollect"]);
  const active = scan ? batchIds(scan) : null;
  const confirmations = new Map(input.entries.map(entry => [entry.id, entry.includeProtected]));
  const moved = new Set(excluded);
  const failed = new Set(confirmations.keys());
  let completed = 0;
  for (const item of items) {
    if (!confirmations.has(item.id)) continue;
    if ((active && !active.has(item.id)) || item.status !== "open" || removals.has(item.id) ||
        (protectedItem(item) && !confirmations.get(item.id))) {
      continue;
    }
    item.reviewRemoved = true;
    item.status = "closed";
    item.due = "";
    moved.add(item.id);
    failed.delete(item.id);
    completed++;
  }
  await chrome.storage.local.set({
    items, excluded: [...moved],
    pendingUncollect: pendingUncollect.filter(entry => !confirmations.has(entry.id) || failed.has(entry.id))
  });
  return { completed, failed: [...failed] };
}

chrome.runtime.onMessage.addListener((input, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !["add", "convert", "checkin", "uncollect", "scan-start", "scan-next", "scan-step", "site-resume", "cleanup-decision", "cleanup-move", "open-original", "uncollect-enqueue", "uncollect-next", "uncollect-drop"].includes(input?.op)) return;
  const operations = {
    uncollect: () => removeFromCollection(input.id, input.rejectIfProtected),
    "uncollect-enqueue": () => run(() => enqueueUncollect(input.entries)),
    "uncollect-next": () => removeFromCollection(input.id, false, true),
    "uncollect-drop": () => run(() => dropPendingUncollect(input.id)),
    "open-original": () => siteAction(async () => {
      const { items = [], scan } = await chrome.storage.local.get(["items", "scan"]);
      assertBatch(scan, input.id);
      await openOriginal(chrome, items.find(item => item.id === input.id));
    }),
    "scan-start": () => beginScan(input),
    "scan-next": () => beginScan(input),
    "site-resume": () => resumeSite(input.tabId),
    "scan-step": advanceScan,
    "cleanup-decision": () => run(() => cleanupDecision(input)),
    "cleanup-move": () => run(() => moveOutOfReview(input))
  };
  const operation = operations[input.op]?.() ?? run(() => changeItems(input));
  operation.then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.items || changes.scan)) run(refreshReminder);
});
run(ensureAlarm);
