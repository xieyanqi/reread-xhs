import { csvCell } from "./scan.js";
import { captureActiveTab } from "./capture.js";
import { dayAfter, isDue, kinds, localDay, outcomes, source } from "./model.js";

const $ = selector => document.querySelector(selector);
const editor = $("#editor");
const checkDialog = $("#check-dialog");
const dashboard = location.hash.length > 0;
let view = location.hash === "#due" ? "due" : "inbox";
let items = [];
let scan = null;
let excluded = [];
let scanning = false;
let scanBusy = false;
let listPage = 0;
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

async function importEntries(entries, pageResult) {
  if (pageResult?.reason === "choose-collection") {
    showNotice("批量导入请打开「我的主页 → 收藏 → 笔记」。");
    return false;
  }
  if (pageResult?.reason === "unavailable-collection") {
    showNotice("未能确认当前是收藏笔记列表。请刷新「收藏 → 笔记」，等卡片出现后再点导入。");
    return false;
  }
  if (!entries.length) {
    showNotice(pageResult?.collection
      ? "在收藏列表中识别到 0 条笔记。"
      : "未识别到小红书帖子链接。可以打开单篇原帖，或粘贴分享链接。");
    return false;
  }
  const { added, matched, skipped } = await commit({
    op: "add", entries, collection: Boolean(pageResult?.collection)
  });
  if (!matched && !skipped) {
    showNotice("未识别到小红书帖子链接。");
    return false;
  }
  view = "inbox";
  render();
  showNotice(`识别到 ${matched + skipped} 条，新增 ${added} 条${matched > added ? `，已收录 ${matched - added} 条` : ""}${skipped ? `，跳过已移出的 ${skipped} 条` : ""}。`);
  return true;
}

$("#capture").addEventListener("click", async () => {
  const button = $("#capture");
  button.disabled = true;
  showNotice("正在读取当前页面…");
  try {
    let result;
    try {
      result = await captureActiveTab(chrome, items.map(item => item.id));
    } catch (error) {
      showNotice(error.message);
      return;
    }
    await importEntries(result.entries, result);
  } catch (error) {
    console.warn("Could not import entries", error);
    showNotice("保存失败，请重试。");
  } finally {
    button.disabled = false;
  }
});

$("#paste-form").addEventListener("submit", async event => {
  event.preventDefault();
  const field = $("#links");
  const entries = (field.value.match(/https?:\/\/[^\s\u3000<>"'，。；！？、）】》]+/gi) || [])
    .map(url => ({ url: url.replace(/[),.;]+$/, "") }));
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    if (await importEntries(entries)) field.value = "";
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
  }
});

const scanStops = {
  "unavailable": "暂时读不到小红书的分页状态。",
  "waiting": "小红书还在加载，请稍后继续。",
  "request-stopped": "小红书这次加载失败或超时。",
  "no-progress": "小红书没有返回新的一页，扫描已暂停。",
  "tab-changed": "扫描标签页已关闭或切换，请从头重扫。",
  "list-changed": "小红书列表顺序已变化，请从头重扫以重新核对。",
  "restarted": "扫描已在另一个窗口重开。"
};

function drawScan() {
  const resume = $("#scan-resume");
  $("#scan-start").disabled = scanBusy;
  $("#scan-resume").disabled = scanBusy;
  $("#scan-pause").hidden = !scanning;
  $("#scan-export").hidden = !scan?.rows.length;
  resume.hidden = dashboard || !scan || scanning || ["site-end", "tab-changed", "list-changed"].includes(scan.stop);
  const progress = $("#scan-progress");
  progress.hidden = !scan?.expected;
  progress.max = scan?.expected || 1;
  progress.value = Math.min(scan?.unique || 0, progress.max);
  if (!scan) return;
  const expected = scan.expected == null ? "网站总数暂未识别" : `小红书显示 ${scan.expected} 条`;
  const difference = scan.expected == null ? "" : ` · 差 ${Math.max(0, scan.expected - scan.unique)} 条`;
  const clean = scan.expected === scan.lastTotal && scan.unique === scan.expected && scan.rows.length === scan.unique;
  const status = scanning ? "正在按小红书列表顺序扫描…" : scan.stop === "site-end"
    ? (clean ? "已到末页，去重后的数量与网站总数一致。" : "网站已返回末页，仍有数量差异或总数待核对。")
    : (scanStops[scan.stop] || "已暂停，可以继续。");
  const extra = scan.lastTotal !== scan.expected ? `
扫描期间网站总数变为 ${scan.lastTotal} 条。` : "";
  $("#scan-summary").textContent = `从第 1 条开始 · 已读 ${scan.rows.length} 行 · 确认 ${scan.unique} 条不同笔记
${expected}${difference}。
${status}${extra}`;
}

async function runScan(start) {
  if (scanBusy) return;
  scanBusy = scanning = true;
  drawScan();
  try {
    if (start) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) throw new Error("请先在浏览器打开小红书收藏页。");
      await commit({ op: "scan-start", tabId: tab.id });
    }
    let loadingChecks = 0;
    while (scanning) {
      const { stop } = await commit({ op: "scan-step" });
      if (stop && stop !== "loading") break;
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

$("#scan-start").addEventListener("click", () => runScan(true));
$("#scan-resume").addEventListener("click", () => runScan(false));
$("#scan-pause").addEventListener("click", () => {
  scanning = false;
  drawScan();
});
$("#scan-export").addEventListener("click", () => {
  if (!scan?.rows.length) return;
  const byId = new Map(items.map(item => [item.id, item]));
  const skipped = new Set(excluded);
  const rows = [["网站返回顺序", "标题", "帖子 ID", "原帖", "核对结果"]];
  for (const [index, row] of scan.rows.entries()) {
    const item = byId.get(row.id);
    const status = !row.id ? "无法识别帖子 ID" : row.duplicate ? "网站返回重复项" :
      skipped.has(row.id) ? "已移出复读" : item ? "已收录" : "未收录";
    const link = row.id ? (item?.url || `https://www.xiaohongshu.com/explore/${row.id}`) : "";
    rows.push([index + 1, row.title, row.id, link, status]);
  }
  const content = "\ufeff" + rows.map(fields => fields.map(csvCell).join(",")).join("\r\n");
  downloadFile(content, "text/csv;charset=utf-8", `reread-audit-${localDay()}.csv`);
});

function render() {
  const groups = {
    inbox: items.filter(item => item.kind === "inbox"),
    due: items.filter(item => isDue(item)).sort((a, b) => a.due.localeCompare(b.due)),
    all: items
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
    inbox: ["待复读列表是空的", "打开小红书收藏页，滚动加载想导入的帖子，再点击导入。"],
    due: ["今天没有到期条目", "用「全部」查看已经安排的笔记和行动，也可以提前复盘。"],
    all: ["还没有收录的帖子", "导入一篇最近收藏的帖子，试着写下它能帮你做什么。"]
  };
  [title.textContent, hint.textContent] = copy[view];
  if (search) {
    title.textContent = "没有匹配的收藏";
    hint.textContent = "可以换一个关键词，或切到「全部」搜索。";
  } else if (dashboard && view === "inbox") hint.textContent = "在小红书标签页打开拾读，或在这里粘贴分享链接。";
  empty.append(title, hint);
  list.replaceChildren(empty);
}

function itemTitle(item) {
  return item.title || "小红书帖子";
}

async function removeFavorite(item) {
  if (removing.has(item.id)) return;
  removing.add(item.id);
  render();
  showNotice("正在检查这条笔记在小红书上的收藏状态…");
  try {
    const { outcome } = await commit({ op: "uncollect", id: item.id });
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
  date.textContent = item.favoriteRemoved ? "已取消收藏" : item.due
    ? `回看 ${item.due}${due ? (item.due < localDay() ? " · 已逾期" : " · 今天") : ""}`
    : (item.kind !== "archived" && item.status === "closed" ? "已完成" : "");
  date.classList.toggle("overdue", due);
  card.querySelector("h2").textContent = itemTitle(item);
  const body = card.querySelector(".body");
  body.textContent = item.body;
  body.hidden = !item.body;
  card.querySelector("a").href = item.url;
  const edit = card.querySelector(".edit");
  edit.textContent = item.kind === "inbox" ? "写笔记 / 行动" : "编辑";
  edit.hidden = item.status === "closed";
  edit.addEventListener("click", () => openEditor(item));
  const check = card.querySelector(".check");
  check.hidden = item.status === "closed" || !item.due;
  check.addEventListener("click", () => openCheck(item));
  const uncollect = card.querySelector(".uncollect");
  uncollect.hidden = item.favoriteRemoved || !source(item.url) || item.id.startsWith("share:");
  uncollect.disabled = removing.has(item.id);
  uncollect.textContent = uncollect.disabled ? "正在取消…" : "取消收藏并移出";
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
  const blocks = items.map(item => [
    `## ${escape(itemTitle(item).replace(/\s+/g, " "))}`,
    `[原帖](<${item.url}>) · ${kinds[item.kind]}${item.due ? ` · 回看 ${item.due}` : ""}`,
    item.body,
    ...item.history.map(entry => `- ${new Date(entry.at).toLocaleDateString("zh-CN")} · ${outcomes[entry.outcome]}：${entry.text.replace(/\n/g, "\n  ")}`)
  ].filter(Boolean).join("\n\n"));
  return ["# 拾读收藏", ...blocks].join("\n\n") + "\n";
}

$("#export").addEventListener("click", () => {
  if (!items.length) {
    showNotice("收录帖子后就可以导出。");
    return;
  }
  downloadFile(markdown(), "text/markdown;charset=utf-8", `reread-${localDay()}.md`);
});

$("#open-workspace").addEventListener("click", () => {
  chrome.windows.create({ url: chrome.runtime.getURL("index.html#workspace"), type: "popup", width: 790, height: 850 })
    .catch(error => showNotice(error.message));
});
$("#open-workspace").hidden = dashboard;
$("#capture").hidden = dashboard;

$("#scan-start").hidden = dashboard;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.items) {
    items = changes.items.newValue || [];
    render();
  }
  if (changes.excluded) excluded = changes.excluded.newValue || [];
  if (changes.scan) {
    scan = changes.scan.newValue || null;
    drawScan();
  }
});
window.addEventListener("focus", render);
({ items = [], excluded = [], scan = null } = await chrome.storage.local.get(["items", "excluded", "scan"]));
render();
drawScan();
