import { captureActiveTab } from "./capture.js";
import { dayAfter, isDue, kinds, localDay, outcomes } from "./model.js";

const $ = selector => document.querySelector(selector);
const editor = $("#editor");
const checkDialog = $("#check-dialog");
const dashboard = location.hash.length > 0;
let view = location.hash === "#due" ? "due" : "inbox";
let items = [];

function showNotice(message) {
  $("#notice").textContent = message;
}

async function commit(input) {
  const result = await chrome.runtime.sendMessage(input);
  if (!result?.ok) throw new Error(result?.error || "保存失败，请重试。");
  return result;
}

async function importEntries(entries, pageResult) {
  const { added, matched } = await commit({ op: "add", entries });
  if (!matched) {
    showNotice(pageResult?.profile
      ? "识别到 0 条帖子。请确认已选中「收藏」且看到了帖子卡片，再点导入。"
      : "未识别到小红书帖子链接。可以打开单篇原帖，或粘贴分享链接。");
    return false;
  }
  view = "inbox";
  render();
  showNotice(`识别到 ${matched} 条，新增 ${added} 条${matched > added ? `，已收录 ${matched - added} 条` : ""}。`);
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
  if (groups[view].length) {
    list.replaceChildren(...groups[view].map(makeCard));
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
  if (dashboard && view === "inbox") hint.textContent = "在小红书标签页打开拾读，或在这里粘贴分享链接。";
  empty.append(title, hint);
  list.replaceChildren(empty);
}

function itemTitle(item) {
  return item.title || "小红书帖子";
}

function makeCard(item) {
  const card = $("#card-template").content.firstElementChild.cloneNode(true);
  const due = isDue(item);
  const date = card.querySelector(".date");
  const kind = card.querySelector(".kind");
  kind.textContent = kinds[item.kind];
  kind.dataset.kind = item.kind;
  date.textContent = item.due
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
    render();
  });
}

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
  const url = URL.createObjectURL(new Blob([markdown()], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `reread-${localDay()}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

$("#open-workspace").addEventListener("click", () => {
  chrome.windows.create({ url: chrome.runtime.getURL("index.html#workspace"), type: "popup", width: 790, height: 850 })
    .catch(error => showNotice(error.message));
});
$("#open-workspace").hidden = dashboard;
$("#capture").hidden = dashboard;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.items) return;
  items = changes.items.newValue || [];
  render();
});
window.addEventListener("focus", render);
({ items = [] } = await chrome.storage.local.get("items"));
render();
