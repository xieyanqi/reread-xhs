import { batchLimit, batchRows, batchItems, pendingUncollectInBatch, restrictedMessage } from "./batch.js";
import { csvCell } from "./scan.js";
import { dayAfter, isDue, kinds, localDay, outcomes, source } from "./model.js";

const $ = selector => document.querySelector(selector);
const editor = $("#editor");
const checkDialog = $("#check-dialog");
const dashboard = location.hash.length > 0;
let view = location.hash === "#due" ? "due" : "inbox";
let items = [];
let scan = null;
let siteBlocked = false;
let pendingUncollect = [];
let excluded = [];
let scanning = false;
let scanBusy = false;
let listPage = 0;
let replayLoaded = null;
const pageSize = 60;
const removing = new Set();

function showNotice(message) {
  $("#notice").textContent = message;
}

async function commit(input) {
  const result = await chrome.runtime.sendMessage(input);
  if (!result?.ok) throw new Error(result?.error || "保存失败，请重试。");
  return result;
}

const scanStops = {
  "unavailable": "暂时读不到小红书的分页状态。",
  "waiting": "小红书还在加载，请稍后继续。",
  "request-stopped": "小红书这次加载失败或超时。",
  "no-progress": "小红书没有返回新的一页，扫描已暂停。",
  "tab-changed": "扫描页面已跳转到其他地址。请回到原收藏页再继续。",
  "tab-closed": "扫描使用的标签页已关闭，请在收藏页从头重扫。",
  "not-collection": "扫描页当前不是原来的收藏笔记页。请切回「收藏 → 笔记」，再继续扫描。",
  "site-permission": "Chrome 拦截了读取。请检查拾读对小红书的网站访问权限。",
  "needs-site-access": "小红书显示登录或验证页面。请按网站提示处理，再回收藏页继续。",
  "script-error": "页面打开了，但 Chrome 未能运行收藏扫描。请刷新收藏页后重试。",
  "list-changed": "小红书列表顺序已变化，请从头重扫以重新核对。",
  "restarted": "扫描已在另一个窗口重开。",
  "batch-end": "已到本批上限。整理完后，可扫描下一批。"
};

function drawScan() {
  const rows = batchRows(scan);
  const start = scan?.batchStart ?? 0;
  const cachedNext = Boolean(scan && start + batchLimit < scan.rows.length);
  const canReadNext = Boolean(scan && rows.length === batchLimit && scan.stop !== "site-end");
  $("#scan-start").disabled = scanBusy || siteBlocked;
  $("#scan-start").textContent = scan ? "从头重扫" : "从头扫描第一批";
  $("#scan-next").hidden = dashboard || scanning || !(cachedNext || (!siteBlocked && canReadNext));
  $("#scan-next").disabled = scanBusy;
  $("#scan-next").textContent = cachedNext ? "打开下一批已扫笔记" : "扫描下一批";
  $("#scan-resume").disabled = scanBusy || siteBlocked;
  $("#scan-resume").hidden = dashboard || !scan || scanning || rows.length >= batchLimit ||
    ["site-end", "tab-closed", "list-changed"].includes(scan.stop);
  $("#scan-pause").hidden = !scanning;
  $("#scan-export").hidden = !rows.length;
  $("#site-block").textContent = siteBlocked ? restrictedMessage : "";
  $("#site-block").hidden = !siteBlocked;
  $("#site-resume").hidden = dashboard || !siteBlocked;
  const progress = $("#scan-progress");
  progress.hidden = !scan;
  progress.max = batchLimit;
  progress.value = rows.length;
  if (!scan) return;
  const expected = scan.expected == null ? "网站总数暂未识别" : `小红书显示 ${scan.expected} 条`;
  const gap = scan.expected - scan.unique;
  const difference = scan.expected == null ? "" : gap < 0 ? ` · 多 ${-gap} 条` : ` · 差 ${gap} 条`;
  const clean = scan.expected === scan.lastTotal && scan.unique === scan.expected && scan.rows.length === scan.unique;
  const status = siteBlocked ? "访问已暂停。可以继续整理已保存的本批笔记。" : scanning
    ? (replayLoaded == null ? "正在按小红书列表顺序扫描…" : `正在恢复页面进度（已重新加载 ${replayLoaded} / ${scan.rows.length} 行）…`)
    : scan.stop === "site-end"
    ? (clean ? "已到末页，去重后的数量与网站总数一致。" : "网站已返回末页，仍有数量差异或总数待核对。")
    : (rows.length === batchLimit ? scanStops["batch-end"] : scanStops[scan.stop] || "已暂停，可以继续。");
  const extra = scan.lastTotal !== scan.expected ? `
扫描期间网站总数变为 ${scan.lastTotal} 条。` : "";
  $("#scan-summary").textContent = `第 ${Math.floor(start / batchLimit) + 1} 批 · 本批 ${rows.length} / ${batchLimit} 条 · 累计确认 ${scan.unique} 条不同笔记
${expected}${difference}。
${status}${extra}`;
}

async function runScan(op) {
  if (scanBusy) return;
  scanBusy = scanning = true;
  replayLoaded = null;
  drawScan();
  try {
    if (op) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) throw new Error("请先在浏览器打开小红书收藏页。");
      const result = await commit({ op, tabId: tab.id });
      if (result.offline) return;
    }
    let loadingChecks = 0;
    while (scanning) {
      const { stop, loaded } = await commit({ op: "scan-step" });
      replayLoaded = stop === "catching-up" ? loaded : null;
      drawScan();
      if (stop && stop !== "loading" && stop !== "catching-up") break;
      loadingChecks = stop === "loading" ? loadingChecks + 1 : 0;
      if (loadingChecks > 40) throw new Error("收藏页仍在加载。请检查扫描标签页，再点继续扫描。");
      await new Promise(resolve => setTimeout(resolve, stop === "loading" ? 450 : 650));
    }
  } catch (error) {
    showNotice(error.message);
  } finally {
    scanBusy = scanning = false;
    drawScan();
  }
}

function downloadFile(content, mime, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

$("#scan-start").addEventListener("click", () => runScan("scan-start"));
$("#scan-next").addEventListener("click", () => runScan("scan-next"));
$("#scan-resume").addEventListener("click", () => runScan());
$("#site-resume").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await commit({ op: "site-resume", tabId: tab?.id });
    showNotice("收藏页可访问，可以手动继续。");
  } catch (error) {
    showNotice(error.message);
  }
});
$("#scan-pause").addEventListener("click", () => {
  scanning = false;
  drawScan();
});
$("#scan-export").addEventListener("click", () => {
  if (!batchRows(scan).length) return;
  const byId = new Map(items.map(item => [item.id, item]));
  const skipped = new Set(excluded);
  const rows = [["网站返回顺序", "标题", "帖子 ID", "原帖", "核对结果"]];
  for (const [index, row] of batchRows(scan).entries()) {
    const item = byId.get(row.id);
    const status = !row.id ? "无法识别帖子 ID" : row.duplicate ? "网站返回重复项" :
      skipped.has(row.id) ? "已移出复读" : item ? "已收录" : "未收录";
    const link = row.id ? (item?.url || `https://www.xiaohongshu.com/explore/${row.id}`) : "";
    rows.push([(scan.batchStart ?? 0) + index + 1, row.title, row.id, link, status]);
  }
  const content = "\ufeff" + rows.map(fields => fields.map(csvCell).join(",")).join("\r\n");
  downloadFile(content, "text/csv;charset=utf-8", `reread-audit-${localDay()}.csv`);
});

function renderPending() {
  const pending = pendingUncollectInBatch(pendingUncollect, scan);
  const current = pending[0];
  const item = current && items.find(entry => entry.id === current.id);
  $("#pending-panel").hidden = !pendingUncollect.length;
  $("#pending-count").textContent = `本批待取消 ${pending.length} 条${pending.length < pendingUncollect.length
    ? `，其他批次 ${pendingUncollect.length - pending.length} 条` : ""}`;
  $("#pending-current").hidden = !current;
  $("#pending-name").textContent = item ? itemTitle(item) : "这条笔记已不在复读列表，可移出待取消名单。";
  $("#pending-apply").disabled = !item || siteBlocked || Boolean(removing.size);
  $("#pending-apply").textContent = current && removing.has(current.id) ? "正在取消…" : "取消收藏并移出";
  $("#pending-drop").disabled = Boolean(current && removing.has(current.id));
}

$("#pending-apply").addEventListener("click", () => {
  const current = pendingUncollectInBatch(pendingUncollect, scan)[0];
  const item = current && items.find(entry => entry.id === current.id);
  if (item && !siteBlocked && !removing.size) removeFavorite(item, true);
});

$("#pending-drop").addEventListener("click", async () => {
  const current = pendingUncollectInBatch(pendingUncollect, scan)[0];
  if (!current) return;
  try {
    await commit({ op: "uncollect-drop", id: current.id });
    showNotice("已移出待取消名单。");
  } catch (error) {
    showNotice(error.message);
  }
});

function render() {
  renderPending();
  const active = batchItems(items, scan);
  const groups = {
    inbox: active.filter(item => item.kind === "inbox" && item.status === "open"),
    due: active.filter(item => isDue(item)).sort((a, b) => a.due.localeCompare(b.due)),
    all: active
  };
  for (const button of document.querySelectorAll("[data-view]")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
    button.querySelector("span").textContent = groups[button.dataset.view].length;
  }
  const list = $("#list");
  const search = $("#item-search").value.toLocaleLowerCase().trim();
  const filtered = search
    ? groups[view].filter(item => [item.title, item.url, item.body].some(text => text?.toLocaleLowerCase().includes(search)))
    : groups[view];
  const pages = Math.ceil(filtered.length / pageSize);
  listPage = Math.min(listPage, Math.max(0, pages - 1));
  $("#pager").hidden = pages <= 1;
  $("#previous-page").disabled = listPage === 0;
  $("#next-page").disabled = listPage >= pages - 1;
  $("#page-position").textContent = `第 ${listPage + 1} / ${pages} 页 · ${filtered.length} 条`;
  if (filtered.length) {
    const start = listPage * pageSize;
    list.replaceChildren(...filtered.slice(start, start + pageSize).map(makeCard));
    return;
  }
  const empty = document.createElement("div");
  empty.className = "empty";
  const title = document.createElement("h2");
  const hint = document.createElement("p");
  const copy = {
    inbox: ["待复读列表是空的", "打开小红书收藏页，点击「从头扫描第一批」。"],
    due: ["今天没有到期条目", "用「全部」查看已经安排的笔记和行动，也可以提前复盘。"],
    all: ["还没有收录的帖子", "导入一篇最近收藏的帖子，试着写下它能帮你做什么。"]
  };
  [title.textContent, hint.textContent] = copy[view];
  if (search) {
    title.textContent = "没有匹配的收藏";
    hint.textContent = "可以换一个关键词，或切到「全部」搜索。";
  } else if (dashboard && view === "inbox") hint.textContent = "在小红书收藏页打开拾读并开始扫描。";
  empty.append(title, hint);
  list.replaceChildren(empty);
}

function itemTitle(item) {
  return item.title || "小红书帖子";
}

async function removeFavorite(item, fromQueue = false) {
  if (removing.has(item.id)) return;
  removing.add(item.id);
  render();
  showNotice("正在检查这条笔记在小红书上的收藏状态…");
  try {
    const { outcome } = await commit({ op: fromQueue ? "uncollect-next" : "uncollect", id: item.id });
    showNotice(outcome === "already-removed"
      ? "原帖当前未收藏，已移出复读。"
      : "已在小红书取消收藏，并移出复读。");
  } catch (error) {
    showNotice(error.message);
  } finally {
    removing.delete(item.id);
    render();
  }
}

function makeCard(item) {
  const card = $("#card-template").content.firstElementChild.cloneNode(true);
  const due = isDue(item);
  const date = card.querySelector(".date");
  const kind = card.querySelector(".kind");
  kind.textContent = kinds[item.kind];
  kind.dataset.kind = item.kind;
  date.textContent = item.favoriteRemoved ? "已取消收藏" : item.reviewRemoved ? "已移出复读" : item.due
    ? `回看 ${item.due}${due ? (item.due < localDay() ? " · 已逾期" : " · 今天") : ""}`
    : (item.kind !== "archived" && item.status === "closed" ? "已完成" : "");
  date.classList.toggle("overdue", due);
  card.querySelector("h2").textContent = itemTitle(item);
  const body = card.querySelector(".body");
  body.textContent = item.body;
  body.hidden = !item.body;
  const original = card.querySelector("a");
  original.href = item.url;
  original.addEventListener("click", event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    showNotice("正在打开原帖…");
    commit({ op: "open-original", id: item.id }).then(() => showNotice(""), error => showNotice(error.message));
  });
  const edit = card.querySelector(".edit");
  edit.textContent = item.kind === "inbox" ? "写笔记 / 行动" : "编辑";
  edit.hidden = item.status === "closed";
  edit.addEventListener("click", () => openEditor(item));
  const check = card.querySelector(".check");
  check.hidden = item.status === "closed" || !item.due;
  check.addEventListener("click", () => openCheck(item));
  const uncollect = card.querySelector(".uncollect");
  uncollect.hidden = item.favoriteRemoved || !source(item.url) || item.id.startsWith("share:");
  uncollect.disabled = removing.has(item.id) || siteBlocked;
  uncollect.textContent = removing.has(item.id) ? "正在取消…" : "取消收藏并移出";
  uncollect.addEventListener("click", () => removeFavorite(item));
  const history = card.querySelector(".history");
  history.hidden = !item.history.length;
  history.open = Boolean(item.history.length && item.status === "closed");
  history.querySelector("summary").textContent = `复盘记录 · ${item.history.length}`;
  for (const entry of item.history) {
    const row = document.createElement("li");
    const date = document.createElement("strong");
    date.textContent = `${new Date(entry.at).toLocaleDateString("zh-CN")} · ${outcomes[entry.outcome]}`;
    const note = document.createElement("p");
    note.textContent = entry.text;
    row.append(date, note);
    history.querySelector("ol").append(row);
  }
  return card;
}

function editorFields() {
  const kind = $("#kind").value;
  const archived = kind === "archived";
  $("#body-label").textContent = {
    note: "用自己的话写下值得留下的内容",
    action: "下一步准备做什么？写一个能做完的动作",
    archived: "归档理由（选填）"
  }[kind];
  $("#date-field").hidden = archived;
  $("#body").required = $("#due-date").required = !archived;
}

function openEditor(item) {
  editor.dataset.id = item.id;
  $("#title").value = item.title;
  $("#kind").value = item.kind === "inbox" ? "note" : item.kind;
  $("#body").value = item.body;
  $("#due-date").value = item.due || dayAfter(7);
  editorFields();
  editor.querySelector(".error").textContent = "";
  editor.showModal();
}

function checkFields() {
  const outcome = $("#outcome").value;
  $("#next-field").hidden = outcome === "complete";
  $("#next-date").required = outcome !== "complete";
  $("#check-label").textContent = {
    progress: checkDialog.dataset.kind === "note" ? "这次想起或用上了什么？" : "这次做了什么？",
    blocked: "卡在哪里？下次准备怎么试？",
    complete: checkDialog.dataset.kind === "note" ? "最后想留下什么？" : "完成后的结果是什么？"
  }[outcome];
}

function openCheck(item) {
  checkDialog.dataset.id = item.id;
  checkDialog.dataset.kind = item.kind;
  $("#check-form").reset();
  $("#next-date").min = dayAfter(1);
  $("#next-date").value = dayAfter(7);
  checkFields();
  checkDialog.querySelector(".error").textContent = "";
  checkDialog.showModal();
}

function bindDialog(dialog, getInput) {
  dialog.querySelector(".cancel").addEventListener("click", () => dialog.close());
  dialog.addEventListener("submit", async event => {
    event.preventDefault();
    const button = dialog.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const input = getInput();
      await commit({ id: dialog.dataset.id, ...input });
      dialog.close();
      if (input.op === "convert" || input.outcome === "complete") view = "all";
      render();
      showNotice(input.op === "convert" ? "已保存处理结果。" : "已记录这次复盘。");
    } catch (error) {
      dialog.querySelector(".error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

$("#kind").addEventListener("change", editorFields);
$("#outcome").addEventListener("change", checkFields);
bindDialog(editor, () => ({
  op: "convert", title: $("#title").value, kind: $("#kind").value,
  body: $("#body").value, due: $("#due-date").value
}));
bindDialog(checkDialog, () => ({
  op: "checkin", outcome: $("#outcome").value, text: $("#check-text").value, due: $("#next-date").value
}));

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    view = button.dataset.view;
    listPage = 0;
    render();
  });
}

$("#item-search").addEventListener("input", () => { listPage = 0; render(); });
$("#previous-page").addEventListener("click", () => { listPage--; render(); $("#list").scrollIntoView(); });
$("#next-page").addEventListener("click", () => { listPage++; render(); $("#list").scrollIntoView(); });

function markdown() {
  const escape = text => text.replace(/[\\`*_{}\[\]()#!<>]/g, "\\$&");
  const blocks = batchItems(items, scan).map(item => [
    `## ${escape(itemTitle(item).replace(/\s+/g, " "))}`,
    `[原帖](<${item.url}>) · ${kinds[item.kind]}${item.due ? ` · 回看 ${item.due}` : ""}`,
    item.body,
    ...item.history.map(entry => `- ${new Date(entry.at).toLocaleDateString("zh-CN")} · ${outcomes[entry.outcome]}：${entry.text.replace(/\n/g, "\n  ")}`)
  ].filter(Boolean).join("\n\n"));
  return ["# 拾读收藏", ...blocks].join("\n\n") + "\n";
}

$("#export").addEventListener("click", () => {
  if (!batchItems(items, scan).length) {
    showNotice("收录帖子后就可以导出。");
    return;
  }
  downloadFile(markdown(), "text/markdown;charset=utf-8", `reread-${localDay()}.md`);
});

$("#open-workspace").addEventListener("click", () => {
  chrome.windows.create({ url: chrome.runtime.getURL("index.html#workspace"), type: "popup", width: 790, height: 850 })
    .catch(error => showNotice(error.message));
});
$("#open-cleanup").addEventListener("click", () => {
  const url = chrome.runtime.getURL("cleanup.html");
  if (dashboard) location.href = url;
  else chrome.windows.create({ url, type: "popup", width: 850, height: 900 }).catch(error => showNotice(error.message));
});
$("#open-workspace").hidden = dashboard;
$("#scan-start").hidden = dashboard;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.items) items = changes.items.newValue || [];
  if (changes.excluded) excluded = changes.excluded.newValue || [];
  if (changes.scan) {
    if (changes.scan.oldValue?.batchStart !== changes.scan.newValue?.batchStart ||
        changes.scan.oldValue?.id !== changes.scan.newValue?.id) listPage = 0;
    scan = changes.scan.newValue || null;
  }
  if (changes.siteBlocked) siteBlocked = Boolean(changes.siteBlocked.newValue);
  if (changes.pendingUncollect) pendingUncollect = changes.pendingUncollect.newValue || [];
  if (changes.scan || changes.siteBlocked) drawScan();
  if (changes.items || changes.scan || changes.siteBlocked || changes.pendingUncollect) render();
});
window.addEventListener("focus", render);
({ items = [], excluded = [], scan = null, siteBlocked = false, pendingUncollect = [] } =
  await chrome.storage.local.get(["items", "excluded", "scan", "siteBlocked", "pendingUncollect"]));
render();
drawScan();
