export const kinds = { inbox: "待复读", note: "笔记", action: "行动", archived: "已归档" };
export const outcomes = { progress: "有进展", blocked: "卡住了", complete: "已完成" };

export function localDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function dayAfter(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDay(date);
}

export function source(raw) {
  try {
    const url = new URL(raw);
    if (url.hostname === "xhslink.com" && url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const hosts = ["xiaohongshu.com", "www.xiaohongshu.com", "m.xiaohongshu.com"];
    const match = url.pathname.match(/^\/(?:explore|discovery\/item|user\/profile\/[\w-]+)\/([a-f\d]{24})\/?$/i);
    if (hosts.includes(url.hostname) && match) {
      url.hash = "";
      return { id: match[1].toLowerCase(), url: url.href };
    }
    if (url.hostname === "xhslink.com" && /^\/(?:[ao]\/)?[\w-]+\/?$/.test(url.pathname)) {
      url.hash = "";
      return { id: `share:${url.pathname.replace(/\/$/, "")}`, url: url.href };
    }
  } catch {
    return null;
  }
  return null;
}

export function isDue(item, today = localDay()) {
  return Boolean(item.due && item.due <= today && item.status === "open");
}

export function addSources(items, entries) {
  const byId = new Map(items.map(item => [item.id, item]));
  let added = 0;
  let matched = 0;
  for (const entry of entries) {
    const parsed = source(entry.url);
    if (!parsed) continue;
    matched += 1;
    const title = (entry.title || "").trim().slice(0, 120);
    const existing = byId.get(parsed.id);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (new URL(parsed.url).searchParams.has("xsec_token")) existing.url = parsed.url;
      continue;
    }
    const item = {
      ...parsed, title, kind: "inbox", status: "open", body: "", due: "",
      createdAt: new Date().toISOString(), history: []
    };
    byId.set(item.id, item);
    items.unshift(item);
    added += 1;
  }
  return { added, matched };
}

export function updateItem(item, input) {
  if (!item) throw new Error("找不到这条收藏。");
  if (item.status === "closed") throw new Error("这条收藏已结项。");
  if (input.op === "convert") {
    if (!Object.hasOwn(kinds, input.kind) || input.kind === "inbox") throw new Error("请选择处理方式。");
    if (input.kind !== "archived" && (!input.body.trim() || !input.due)) {
      throw new Error("请填写内容和回看日期。");
    }
    item.title = input.title.trim() || item.title;
    item.kind = input.kind;
    item.body = input.body.trim();
    item.due = input.kind === "archived" ? "" : input.due;
    item.status = input.kind === "archived" ? "closed" : "open";
  } else if (input.op === "checkin") {
    if (!["note", "action"].includes(item.kind)) throw new Error("这条收藏已结项。");
    if (!Object.hasOwn(outcomes, input.outcome)) throw new Error("请选择复盘结果。");
    if (!input.text.trim()) throw new Error("请写一句复盘记录。");
    if (input.outcome !== "complete" && input.due <= localDay()) {
      throw new Error("请选择今天之后的下次回看日期。");
    }
    item.history.unshift({ at: new Date().toISOString(), outcome: input.outcome, text: input.text.trim() });
    item.status = input.outcome === "complete" ? "closed" : "open";
    item.due = item.status === "closed" ? "" : input.due;
  }
}
