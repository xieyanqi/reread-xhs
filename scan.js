import { xhsHosts } from "./model.js";

export function isCollectionUrl(raw) {
  const u = new URL(raw);
  return u.protocol === "https:" && xhsHosts.includes(u.hostname) &&
    /^\/user\/profile\/[\w-]+\/?$/.test(u.pathname) &&
    /^(fav|collect)$/.test(u.searchParams.get("tab") || "") &&
    (u.searchParams.get("subTab") || "note") === "note";
}

// Runs inside the current, signed-in collection tab. The site's own list controls pagination.
export async function scanPage(expectedUrl, offset, firstId, previousId) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const page = new URL(expectedUrl);
  if (location.href !== page.href) return { stop: "tab-changed" };

  function profileStore() {
    return document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get("user");
  }

  function row(entry) {
    const card = entry?.noteCard ?? entry?.note_card ?? entry;
    const rawId = card?.noteId ?? card?.note_id ?? entry?.id;
    const id = typeof rawId === "string" && /^[a-f\d]{24}$/i.test(rawId) ? rawId.toLowerCase() : "";
    const rawTitle = card?.displayTitle ?? card?.display_title ?? card?.title;
    const title = typeof rawTitle === "string" ? rawTitle.trim().slice(0, 120) : "";
    if (!id) return { id: "", title, url: "" };
    const url = new URL(`${page.pathname.replace(/\/$/, "")}/${id}`, page.origin);
    const token = entry?.xsecToken ?? entry?.xsec_token ?? card?.xsecToken ?? card?.xsec_token;
    if (typeof token === "string" && token) {
      url.searchParams.set("xsec_token", token);
      url.searchParams.set("xsec_source", "pc_user");
    }
    return { id, title, url: url.href };
  }

  function expectedTotal() {
    for (const node of document.querySelectorAll("span, button, [role=tab], div")) {
      if (node.childElementCount > 3) continue;
      const text = node.textContent;
      if (text.length > 30) continue;
      const match = text.trim().match(/^(?:笔记|筆記|Notes)\s*(?:[·•・]\s*)?(\d[\d,， ]*)$/i);
      if (match && node.getClientRects().length) return Number(match[1].replace(/[,， ]/g, ""));
    }
    return null;
  }

  function read(store) {
    const list = store?.$state?.notes?.[1];
    const query = store?.$state?.noteQueries?.[1];
    return { list, query };
  }

  let store, list, query;
  for (let i = 0; i < 16; i++) {
    if (location.href !== page.href) return { stop: "tab-changed" };
    store = profileStore();
    ({ list, query } = read(store));
    if (Array.isArray(list) && query && (list.length || query.hasMore === false)) break;
    await pause(250);
  }
  const total = expectedTotal();
  if (!Array.isArray(list) || !query) return { stop: "unavailable", total };
  if (offset && (list.length < offset || row(list[0]).id !== firstId || row(list[offset - 1]).id !== previousId)) {
    return { stop: "list-changed", total };
  }

  let noProgress = false;
  if (list.length === offset && query.hasMore === true && typeof store.fetchNotes === "function") {
    if (query.loading || query.isLoading) return { stop: "waiting", total };
    let timer;
    try {
      const loading = Promise.resolve().then(() => store.fetchNotes()).then(() => true, () => false);
      const finished = await Promise.race([loading, new Promise(resolve => { timer = setTimeout(() => resolve(false), 14000); })]);
      if (!finished) return { stop: "request-stopped", total };
    } finally {
      clearTimeout(timer);
    }
    if (location.href !== page.href) return { stop: "tab-changed", total };
    ({ list, query } = read(store));
    if (!Array.isArray(list) || !query ||
        (offset && (list.length < offset || row(list[0]).id !== firstId || row(list[offset - 1]).id !== previousId))) {
      return { stop: "list-changed", total };
    }
    noProgress = list.length === offset && query.hasMore !== false;
  }

  const end = Math.min(list.length, offset + 150);
  const rows = list.slice(offset, end).map(row);
  const atEnd = end === list.length;
  let stop = "";
  if (noProgress) stop = "no-progress";
  else if (atEnd && query.hasMore === false) stop = "site-end";
  else if (atEnd && (query.hasMore !== true || typeof store.fetchNotes !== "function")) stop = "unavailable";
  return { rows, stop, total };
}

export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
