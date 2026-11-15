// URL aliases, query ordering and tracking parameters identify the same collection.
export function collectionProfile(raw, allowMissingTab = false) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const profile = url.pathname.match(/^\/user\/profile\/([\w-]+)\/?$/)?.[1];
    const tab = url.searchParams.get("tab");
    if (url.protocol !== "https:" || !["xiaohongshu.com", "www.xiaohongshu.com", "m.xiaohongshu.com"].includes(url.hostname) ||
        !(tab ? /^(fav|collect)$/i.test(tab) : allowMissingTab) ||
        !/^note$/i.test(url.searchParams.get("subTab") || "note")) return null;
    return profile || null;
  } catch {
    return null;
  }
}

export function isCollectionUrl(raw) {
  return Boolean(collectionProfile(raw));
}

export async function scanPage(expectedUrl, offset, firstId, previousId) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const expectedProfile = new URL(expectedUrl).pathname.match(/^\/user\/profile\/([\w-]+)\/?$/)?.[1];

  function contextStatus() {
    const url = new URL(location.href);
    const currentProfile = url.pathname.match(/^\/user\/profile\/([\w-]+)\/?$/)?.[1];
    if (url.protocol !== "https:" || !["xiaohongshu.com", "www.xiaohongshu.com", "m.xiaohongshu.com"].includes(url.hostname)) return "tab-changed";
    if (/login|captcha|verify|website-login/i.test(url.pathname)) return "needs-site-access";
    if (!currentProfile || currentProfile !== expectedProfile) return "tab-changed";
    const tab = url.searchParams.get("tab");
    if (tab && !/^(fav|collect)$/i.test(tab)) return "not-collection";
    if (!/^note$/i.test(url.searchParams.get("subTab") || "note")) return "not-collection";
    const active = Array.from(document.querySelectorAll('[role=tab][aria-selected=true], .user-tabs .active, .reds-tab-item.active'));
    if (active.some(node => /^(点赞|赞过|喜欢|liked)$/i.test(node.textContent.trim()))) return "not-collection";
    if (!tab && !active.some(node => /^(收藏|收藏的笔记|saved|favorites)$/i.test(node.textContent.trim()))) return "not-collection";
    return "";
  }

  function profileStore() {
    for (const element of document.querySelectorAll("#app, [data-v-app]")) {
      const properties = element.__vue_app__?.config?.globalProperties;
      const store = properties?.$pinia?._s?.get("user");
      if (store) return store;
    }
    return null;
  }

  function row(entry) {
    const card = entry?.noteCard ?? entry?.note_card ?? entry;
    const rawId = card?.noteId ?? card?.note_id ?? entry?.id;
    const id = typeof rawId === "string" && /^[a-f\d]{24}$/i.test(rawId) ? rawId.toLowerCase() : "";
    const rawTitle = card?.displayTitle ?? card?.display_title ?? card?.title;
    const title = typeof rawTitle === "string" ? rawTitle.trim().slice(0, 120) : "";
    if (!id) return { id: "", title, url: "" };
    const url = new URL(`/user/profile/${expectedProfile}/${id}`, location.href);
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
  for (let i = 0; i < 28; i++) {
    const issue = contextStatus();
    if (issue) return { stop: issue };
    store = profileStore();
    ({ list, query } = read(store));
    if (Array.isArray(list) && query && (list.length || query.hasMore === false)) break;
    await pause(250);
  }
  const total = expectedTotal();
  if (!Array.isArray(list) || !query) return { stop: "unavailable", total };
  const sameBoundary = () => !offset ||
    (!list.length || row(list[0]).id === (firstId || "")) &&
    (list.length < offset || row(list[offset - 1]).id === (previousId || ""));
  if (!sameBoundary()) return { stop: "list-changed", total };

  let noProgress = false;
  if (list.length <= offset && query.hasMore !== false) {
    if (query.loading || query.isLoading) return { stop: "waiting", total };
    const before = list.length;
    if (typeof store.fetchNotes === "function") {
      let timer;
      try {
        const loading = Promise.resolve().then(() => store.fetchNotes()).then(() => true, () => false);
        const finished = await Promise.race([loading, new Promise(resolve => { timer = setTimeout(() => resolve(false), 12000); })]);
        if (!finished) return { stop: "request-stopped", total };
      } finally {
        clearTimeout(timer);
      }
      const issue = contextStatus();
      if (issue) return { stop: issue, total };
      ({ list, query } = read(store));
    }
    if (list?.length === before && query?.hasMore !== false) {
      // Trigger the website's own on-scroll loader when its native method did not add a page.
      const grids = Array.from(document.querySelectorAll(".feeds-container, .note-list"))
        .filter(grid => grid.getClientRects().length && grid.querySelector(".note-item"));
      const tails = new Set(grids.map(grid => Array.from(grid.querySelectorAll(".note-item")).at(-1)));
      if (tails.size === 1) {
        [...tails][0].scrollIntoView({ block: "end", behavior: "instant" });
        for (let i = 0; i < 10; i++) {
          await pause(250);
          const issue = contextStatus();
          if (issue) return { stop: issue, total };
          ({ list, query } = read(store));
          if (list?.length !== before || query?.hasMore === false) break;
        }
      }
    }
    if (!Array.isArray(list) || !query || !sameBoundary()) return { stop: "list-changed", total };
    noProgress = list.length === before && query.hasMore !== false;
  }
  if (list.length < offset) {
    const stop = query.hasMore === false ? "list-changed" : noProgress ? "no-progress" : "catching-up";
    return { stop, total, loaded: list.length };
  }

  const end = Math.min(list.length, offset + 150);
  const rows = list.slice(offset, end).map(row);
  const atEnd = end === list.length;
  let stop = "";
  if (noProgress) stop = "no-progress";
  else if (atEnd && query.hasMore === false) stop = "site-end";
  else if (atEnd && query.hasMore == null && !rows.length) stop = "unavailable";
  return { rows, stop, total };
}

export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
