import { batchItems, restrictedMessage } from "./batch.js";
import { availableItems, canUncollect, expiryDate, protectedItem, selectRound, topicGroups } from "./cleanup-model.js";

const $ = selector => document.querySelector(selector);
const selection = new Map();
const pageSize = 24;
let stage = "expiry", storedItems = [], items = [], scan = null, siteBlocked = false;
let preferences = {}, topic = "", page = 0;
let quick = { ids: [], cursor: 0 };
let candidates = [];
const confirmed = new Set();
let running = false;
const confirm = $("#confirm");
const words = {
  expiry: ["先看已过期的消息", "这里集中看标题写明了完整日期的活动、优惠和报名。打开原帖再判断它还有没有参考价值。"],
  topics: ["哪些话题还值得留？", "根据标题里的词语分组。每组先看三条代表笔记，再决定要不要打开候选名单。"],
  quick: ["每轮逐条看 20 条", "选「待清理」会把帖子加入本轮名单。看完这一轮，再一起决定怎么处理。"]
};

function textNode(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, action, className) {
  const node = textNode("button", label, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function linkFor(item) {
  const link = textNode("a", "打开原帖 ↗");
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.addEventListener("click", event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    state("正在打开原帖…");
    send({ op: "open-original", id: item.id }).then(() => state(""), showError);
  });
  return link;
}

function name(item) {
  return item.title || "未保存标题的小红书帖子";
}

async function send(input) {
  const result = await chrome.runtime.sendMessage(input);
  if (!result?.ok) throw new Error(result?.error || "操作失败，请重试。");
  return result;
}

function state(message) {
  $("#state-message").textContent = message;
}

async function remember(id, decision) {
  const result = await send({ op: "cleanup-decision", id, decision, stage });
  preferences = result.cleanupPreferences;
}

function toggle(item, checked) {
  if (checked) selection.set(item.id, protectedItem(item));
  else selection.delete(item.id);
  drawSelection();
}

function drawSelection() {
  const quickActive = stage === "quick" && quick.ids.length > quick.cursor;
  $("#selection-count").textContent = selection.size ? `待清理 ${selection.size} 条` : "还未选择要清理的笔记";
  $("#review").disabled = !selection.size || quickActive;
}

function article(item, reason) {
  const card = textNode("article", "", "card cleanup-card");
  card.append(textNode("h3", name(item)), textNode("p", reason, "detail"));
  if (protectedItem(item)) card.append(textNode("p", "已写笔记或设过行动，批量选择时会跳过。", "detail"));
  return card;
}

function drawConfirmation() {
  const picked = candidates.filter(({ item }) => confirmed.has(item.id));
  const unavailable = siteBlocked || picked.length > 1 || picked.some(({ item }) => !canUncollect(item));
  $("#unavailable").textContent = siteBlocked ? restrictedMessage : picked.length > 1
    ? "批量操作只移出拾读。取消小红书收藏需要逐条确认。"
    : "这条只有分享短链，请打开原帖后手动处理小红书收藏。";
  $("#confirm-summary").textContent = `已选 ${picked.length} 条。可在这份名单里再取消勾选。`;
  $("#site-mode").disabled = unavailable;
  $("#unavailable").hidden = !unavailable;
  if (unavailable && $("#site-mode").checked) {
    $('#confirm-form input[value="local"]').checked = true;
  }
  const mode = new FormData($("#confirm-form")).get("mode");
  const submit = $("#confirm-run");
  submit.disabled = !picked.length;
  submit.textContent = mode === "site" ? `确认取消收藏 ${picked.length} 条` : `确认移出拾读 ${picked.length} 条`;
}

function openReview(one) {
  const byId = new Map(items.map(item => [item.id, item]));
  candidates = (one ? [[one.id, protectedItem(one)]] : [...selection]).flatMap(([id, includeProtected]) => {
    const item = byId.get(id);
    return item?.status === "open" ? [{ item, includeProtected }] : [];
  });
  if (!candidates.length) return;
  $("#confirm-form").reset();
  $("#run-status").textContent = "";
  $("#failed").replaceChildren();
  $("#failed").hidden = true;
  confirmed.clear();
  $("#confirm-list").replaceChildren(...candidates.map(({ item }) => {
    confirmed.add(item.id);
    const row = document.createElement("li");
    const label = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.addEventListener("change", () => {
      if (check.checked) confirmed.add(item.id);
      else confirmed.delete(item.id);
      drawConfirmation();
    });
    label.append(check, " " + name(item));
    row.append(label);
    return row;
  }));
  $("#confirm-run").hidden = false;
  drawConfirmation();
  confirm.showModal();
}

async function keep(item) {
  await remember(item.id, "keep");
  selection.delete(item.id);
  draw();
}

function showError(error) {
  state(error.message);
}

function listCards(entries) {
  const result = $("#results");
  const pages = Math.ceil(entries.length / pageSize);
  page = Math.min(page, Math.max(0, pages - 1));
  const current = entries.slice(page * pageSize, (page + 1) * pageSize);
  if (!current.length) {
    result.append(textNode("p", "这一组暂时没有待清理的笔记。", "empty"));
    return;
  }
  const toolbar = textNode("div", "", "review-toolbar");
  toolbar.append(button("选中本页未写笔记的条目", () => {
    for (const { item } of current) if (!protectedItem(item)) toggle(item, true);
    draw();
  }), button("取消本页勾选", () => {
    for (const { item } of current) toggle(item, false);
    draw();
  }));
  result.append(toolbar);
  for (const { item, reason } of current) {
    const card = article(item, reason);
    const actions = textNode("div", "", "card-actions");
    const label = textNode("label", "");
    const mark = document.createElement("input");
    mark.type = "checkbox";
    mark.checked = selection.has(item.id);
    mark.setAttribute("aria-label", `待清理：${name(item)}`);
    mark.addEventListener("change", () => toggle(item, mark.checked));
    label.append(mark, "待清理");
    actions.append(linkFor(item), button("保留", () => keep(item).catch(showError)),
      button("处理这一条", () => openReview(item)), label);
    card.append(actions);
    result.append(card);
  }
  $("#more").hidden = pages <= 1;
  $("#previous").disabled = page === 0;
  $("#next").disabled = page >= pages - 1;
  $("#page-number").textContent = `第 ${page + 1} / ${pages} 页 · ${entries.length} 条`;
}

function showTopics(list) {
  const active = topicGroups(list, preferences.topics);
  if (topic) {
    const group = active.find(group => group.label === topic);
    $("#results").append(button("返回主题", () => { topic = ""; page = 0; draw(); }));
    if (group) listCards(group.candidates);
    else $("#results").append(textNode("p", "这一主题的待清理笔记已减少，可以返回查看其他主题。", "empty"));
    return;
  }
  if (!active.length) $("#results").append(textNode("p", "暂时没有标题特征足够明确的主题。", "empty"));
  for (const group of active) {
    const card = textNode("article", "", "card cleanup-card");
    card.append(textNode("h3", `你还想保留「${group.label}」相关收藏吗？`),
      textNode("p", `这一组有 ${group.candidates.length} 条`, "detail"));
    const samples = document.createElement("ol");
    const seen = new Set();
    const representatives = [];
    for (const entry of group.candidates) {
      const title = name(entry.item);
      if (!seen.has(title)) {
        seen.add(title);
        representatives.push(entry);
      }
      if (representatives.length === 3) break;
    }
    for (const entry of group.candidates) {
      if (representatives.length === 3) break;
      if (!representatives.includes(entry)) representatives.push(entry);
    }
    for (const { item } of representatives) samples.append(textNode("li", name(item)));
    card.append(samples);
    const actions = textNode("div", "", "card-actions");
    actions.append(button("看一下可清理的", () => { topic = group.label; page = 0; draw(); }, "primary"),
      button("还关注", () => remember(group.label, "topic").then(draw).catch(showError)));
    card.append(actions);
    $("#results").append(card);
  }
}

function saveQuick() {
  sessionStorage.setItem("cleanup-quick", JSON.stringify({ ...quick, selected: [...selection.keys()] }));
}

async function quickDecision(item, decision) {
  const cursor = quick.cursor;
  if (decision === "mark") toggle(item, true);
  else await remember(item.id, decision);
  if (quick.cursor === cursor) quick.cursor++;
  saveQuick();
  draw();
}

function showQuick(list) {
  const results = $("#results");
  const byId = new Map(list.map(item => [item.id, item]));
  if (!quick.ids.length || quick.cursor >= quick.ids.length) {
    if (quick.ids.length) results.append(textNode("p", `这一轮已看完，共 ${quick.ids.length} 条。`, "empty"));
    results.append(button("开始一轮", () => {
      quick = { ids: selectRound(list), cursor: 0 };
      if (!quick.ids.length) state("没有未处理的候选笔记。");
      saveQuick();
      draw();
    }, "primary"));
    results.lastElementChild.disabled = Boolean(selection.size);
    return;
  }
  while (quick.cursor < quick.ids.length && !byId.has(quick.ids[quick.cursor])) quick.cursor++;
  if (quick.cursor >= quick.ids.length) {
    showQuick(list);
    return;
  }
  const item = byId.get(quick.ids[quick.cursor]);
  const card = article(item, `本轮第 ${quick.cursor + 1} / ${quick.ids.length} 条`);
  const actions = textNode("div", "", "card-actions");
  actions.append(linkFor(item));
  for (const [label, decision] of [["保留", "keep"], ["待清理", "mark"], ["跳过", "skip"]]) {
    actions.append(button(label, () => {
      for (const control of actions.querySelectorAll("button")) control.disabled = true;
      quickDecision(item, decision).catch(error => { showError(error); draw(); });
    }));
  }
  card.append(actions);
  results.append(card);
}

function draw() {
  for (const nav of document.querySelectorAll("[data-stage]")) {
    nav.setAttribute("aria-pressed", String(nav.dataset.stage === stage));
  }
  const list = availableItems(items, preferences, stage);
  $("#stage-title").textContent = words[stage][0];
  $("#hint").textContent = words[stage][1];
  $("#results").replaceChildren();
  $("#more").hidden = true;
  if (stage === "expiry") {
    const dated = list.flatMap(item => {
      const date = expiryDate(item.title || "");
      return date ? [{ item, reason: `标题注明 ${date}，日期已经过去`, date }] : [];
    }).sort((a, b) => a.date.localeCompare(b.date));
    listCards(dated);
  } else if (stage === "topics") {
    showTopics(list);
  } else {
    showQuick(list);
  }
  drawSelection();
}

for (const nav of document.querySelectorAll("[data-stage]")) {
  nav.addEventListener("click", () => {
    if (stage !== nav.dataset.stage && selection.size) {
      state("请先核对当前待清理名单，或取消已勾选的条目。");
      return;
    }
    stage = nav.dataset.stage;
    topic = "";
    page = 0;
    state("");
    draw();
  });
}
$("#previous").addEventListener("click", () => { page--; draw(); });
$("#next").addEventListener("click", () => { page++; draw(); });
$("#review").addEventListener("click", () => openReview());
$("#close-review").addEventListener("click", () => confirm.close());
$("#confirm-form fieldset").addEventListener("change", drawConfirmation);
confirm.addEventListener("close", () => {
  for (const { item } of candidates) {
    if (!confirmed.has(item.id)) selection.delete(item.id);
  }
  if (stage === "quick") saveQuick();
  draw();
});
confirm.addEventListener("cancel", event => { if (running) event.preventDefault(); });

$("#confirm-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (running) return;
  const mode = new FormData(event.currentTarget).get("mode");
  const approved = candidates.filter(({ item }) => confirmed.has(item.id));
  if (!approved.length || (mode === "site" && (siteBlocked || approved.length !== 1 || !canUncollect(approved[0].item)))) return;
  running = true;
  $("#close-review").disabled = true;
  $("#confirm-run").hidden = true;
  $("#confirm-form fieldset").disabled = true;
  for (const box of $("#confirm-list").querySelectorAll("input")) box.disabled = true;
  $("#run-status").textContent = "正在处理…";
  let completed = 0;
  const errors = [];
  try {
    if (mode === "local") {
      const result = await send({ op: "cleanup-move",
        entries: approved.map(({ item, includeProtected }) => ({ id: item.id, includeProtected })) });
      completed = result.completed;
      const failed = new Set(result.failed);
      for (const { item } of approved) {
        if (failed.has(item.id)) errors.push(`${name(item)}：状态有变化，请重新核对。`);
        else selection.delete(item.id);
      }
    } else {
      const [{ item, includeProtected }] = approved;
      await send({ op: "uncollect", id: item.id, rejectIfProtected: !includeProtected });
      selection.delete(item.id);
      completed = 1;
    }
  } catch (error) {
    errors.push(error.message);
  } finally {
    running = false;
    $("#close-review").disabled = false;
    $("#confirm-form fieldset").disabled = false;
    $("#run-status").textContent = `已完成 ${completed} 条，还有 ${approved.length - completed} 条待处理。`;
    $("#failed").replaceChildren(...errors.map(message => textNode("li", message)));
    $("#failed").hidden = !errors.length;
    if (stage === "quick") saveQuick();
    draw();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.items) storedItems = changes.items.newValue || [];
  if (changes.scan) scan = changes.scan.newValue || null;
  if (changes.siteBlocked) siteBlocked = Boolean(changes.siteBlocked.newValue);
  if (changes.cleanupPreferences) preferences = changes.cleanupPreferences.newValue || {};
  if (changes.items || changes.scan) {
    items = batchItems(storedItems, scan);
    const active = new Set(items.map(item => item.id));
    for (const id of selection.keys()) if (!active.has(id)) selection.delete(id);
    if (confirm.open && !running && candidates.some(({ item }) => !active.has(item.id))) confirm.close();
  }
  if (changes.siteBlocked && confirm.open && !running) drawConfirmation();
  if (changes.items || changes.scan || changes.cleanupPreferences) draw();
});
const savedQuick = JSON.parse(sessionStorage.getItem("cleanup-quick") || "null");
const data = await chrome.storage.local.get(["items", "cleanupPreferences", "scan", "siteBlocked"]);
({ items: storedItems = [], cleanupPreferences: preferences = {}, scan = null, siteBlocked = false } = data);
items = batchItems(storedItems, scan);
if (savedQuick) {
  quick = { ids: savedQuick.ids, cursor: savedQuick.cursor };
  const open = new Set(items.filter(item => item.status === "open").map(item => item.id));
  for (const id of savedQuick.selected) if (open.has(id)) selection.set(id, false);
  if (quick.cursor < quick.ids.length || selection.size) stage = "quick";
}
draw();
