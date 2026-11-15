import { xhsHosts, xhsNotePath } from "./model.js";

const siteAccessHelp = "请切到小红书标签页。若已在收藏页，请右键拾读图标，在「可以读取和更改网站数据」里允许访问小红书，然后刷新网页。";

export async function captureActiveTab(browser, previousIds) {
  const query = { active: true };
  let [tab] = await browser.tabs.query({ ...query, currentWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ ...query, lastFocusedWindow: true });
  if (tab?.id == null || !tab.url) throw new Error(siteAccessHelp);
  const url = new URL(tab.url);
  if (url.protocol !== "https:" || !xhsHosts.includes(url.hostname)) {
    throw new Error("请打开网页版小红书的收藏页或一篇帖子，再点导入。");
  }

  for (const world of ["MAIN", "ISOLATED"]) {
    try {
      const [frame] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        world,
        func: readPage,
        args: [previousIds, xhsHosts, xhsNotePath.source, url.origin, world === "MAIN"]
      });
      if (Array.isArray(frame?.result?.entries)) return frame.result;
    } catch (error) {
      const message = error.message;
      if (/cannot access|missing host permission|not allowed|blocked by/i.test(message)) {
        throw new Error(siteAccessHelp);
      }
      if (/no tab|frame.*remov|no frame|navigat/i.test(message)) break;
    }
  }
  throw new Error("页面在读取时切换，或读取程序没有返回结果。请刷新收藏页，等帖子卡片出现后再试。");
}

// Chrome serializes this function when injecting it into the active tab.
export function readPage(previousIds, hosts, notePattern, expectedOrigin, readCollectionState) {
  const page = new URL(location.href);
  if (page.origin !== expectedOrigin) return null;
  const notePath = new RegExp(notePattern, "i");
  const profile = /^\/user\/profile\/[\w-]+\/?$/.test(page.pathname);
  const clean = value => typeof value === "string" ? value.trim().slice(0, 120) : "";
  const trimTitle = value => clean(value?.replace(/\s*[-–|｜]\s*小红书\s*$/, ""));
  const known = new Set(previousIds);
  const found = new Map();

  function add(raw, title) {
    if (!raw) return;
    let url;
    try {
      url = new URL(raw, page.origin);
    } catch {
      return;
    }
    if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.username || url.password || url.port) return;
    const match = url.pathname.match(notePath);
    if (!match) return;
    const id = match[1].toLowerCase();
    url.hash = "";
    const existing = found.get(id);
    const token = Boolean(url.searchParams.get("xsec_token"));
    const useNewLink = !existing || (!existing.token && token);
    found.set(id, {
      url: useNewLink ? url.href : existing.url,
      title: existing?.title || clean(title),
      token: useNewLink ? token : existing.token
    });
  }

  function addCard(id, token, title) {
    if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id)) return;
    const url = new URL("/explore/" + id, page.origin);
    if (typeof token === "string" && token) {
      url.searchParams.set("xsec_token", token);
      url.searchParams.set("xsec_source", "pc_user");
    }
    add(url.href, title);
  }

  if (page.pathname.match(notePath)) {
    add(page.href, trimTitle(
      document.querySelector("#detail-title")?.textContent
      || document.querySelector('meta[property="og:title"]')?.content
      || document.title
    ));
    return { entries: [...found.values()], profile };
  }

  function visible(node) {
    return node.getClientRects().length > 0 && !node.closest('[hidden], [aria-hidden="true"]');
  }

  function collect() {
    const selected = Array.from(document.querySelectorAll(
      '[role="tab"][aria-selected="true"], .user-tabs .active, .user-tab.active, .tab-item.active, .reds-tab-item.active'
    )).find(visible);
    const label = selected?.textContent?.trim();
    const fav = profile && (/收藏|saved|favorites/i.test(label || "") ||
      (!label && /^(fav|collect|saved|favorite)$/.test(page.searchParams.get("tab") || "")));
    // Scope to the displayed results when the site marks them as a tab panel.
    const panelId = selected?.getAttribute("aria-controls");
    const panel = panelId && document.getElementById(panelId);
    const root = panel && visible(panel) ? panel : document;
    const cardSelector = '.note-item, [data-note-id], [data-noteid]';
    for (const node of root.querySelectorAll('a[href], [data-href], [data-url]')) {
      const card = node.closest(cardSelector);
      if (!visible(node) && !(card && visible(card))) continue;
      const title = card?.querySelector(".footer .title, .title, [data-title]")?.textContent
        || node.getAttribute("aria-label")
        || node.textContent
        || node.querySelector("img[alt]")?.alt;
      for (const attr of ["href", "data-href", "data-url"]) add(node.getAttribute(attr), title);
    }
    for (const card of root.querySelectorAll(cardSelector)) {
      if (!visible(card)) continue;
      addCard(
        card.getAttribute("data-note-id") || card.getAttribute("data-noteid"),
        card.getAttribute("data-xsec-token"),
        card.querySelector(".footer .title, .title")?.textContent || card.getAttribute("data-title")
      );
    }
    if (!fav || !readCollectionState) return;
    // The page can have loaded collection results before rendering them as cards.
    const user = window.__INITIAL_STATE__?.user;
    const unwrap = value => value?.value ?? value?._value ?? value?._rawValue ?? value;
    for (const key of ["collectNotes", "collectedNotes", "collect"]) {
      const collection = unwrap(user?.[key]);
      const records = unwrap(collection?.data?.notes ?? collection?.notes ?? collection);
      if (!Array.isArray(records)) continue;
      for (const record of records.flat(2)) {
        const card = record?.noteCard ?? record?.note_card ?? record;
        addCard(
          card?.noteId ?? card?.note_id ?? record?.id,
          record?.xsecToken ?? record?.xsec_token ?? card?.xsecToken ?? card?.xsec_token,
          card?.displayTitle ?? card?.display_title ?? card?.title
        );
      }
    }
  }

  return (async () => {
    for (const delay of [0, 250, 500, 850]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (location.href !== page.href) return null;
      collect();
      if ([...found.keys()].some(id => !known.has(id))) break;
    }
    return { entries: [...found.values()], profile };
  })();
}
