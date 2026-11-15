import { source, xhsHosts, xhsNotePath } from "./model.js";

const unknownState = "无法确认小红书的收藏状态。请打开原帖检查收藏图标，再试一次。";

async function loadTab(browser, tabId, reload = false) {
  let onUpdated, onRemoved, timer;
  try {
    await new Promise((resolve, reject) => {
      onUpdated = (id, change) => {
        if (id === tabId && change.status === "complete") resolve();
      };
      onRemoved = id => {
        if (id === tabId) reject(new Error("用于取消收藏的标签页已关闭。"));
      };
      browser.tabs.onUpdated.addListener(onUpdated);
      browser.tabs.onRemoved.addListener(onRemoved);
      timer = setTimeout(() => reject(new Error("小红书原帖加载超时，请稍后重试。")), 12000);
      if (reload) {
        browser.tabs.reload(tabId, { bypassCache: true }).catch(reject);
      } else {
        browser.tabs.get(tabId).then(tab => {
          if (tab.status === "complete") resolve();
        }, reject);
      }
    });
  } finally {
    clearTimeout(timer);
    browser.tabs.onUpdated.removeListener(onUpdated);
    browser.tabs.onRemoved.removeListener(onRemoved);
  }
}

export async function uncollect(browser, item) {
  const original = source(item?.url);
  if (!original || original.id !== item.id || original.id.startsWith("share:")) {
    throw new Error("这条记录缺少可验证的原帖地址。请从收藏页重新导入它。");
  }

  const tab = await browser.tabs.create({ url: original.url, active: false });
  const check = async click => {
    const [frame] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: readFavoriteControl,
      args: [item.id, xhsHosts, xhsNotePath.source, click]
    });
    return frame?.result;
  };
  try {
    await loadTab(browser, tab.id);
    const before = await check(true);
    if (before === "not-collected") return "already-removed";
    if (before !== "clicked") throw new Error(unknownState);

    // A refreshed note must report the new state before any local record is changed.
    await loadTab(browser, tab.id, true);
    if (await check(false) !== "not-collected") throw new Error(unknownState);
    return "removed";
  } finally {
    await browser.tabs.remove(tab.id).catch(() => {});
  }
}

// Injected into the original note. Only an explicitly selected collection control may be clicked.
export async function readFavoriteControl(id, hosts, notePattern, click) {
  const notePath = new RegExp(notePattern, "i");
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let lastState = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    const page = new URL(location.href);
    if (page.protocol !== "https:" || !hosts.includes(page.hostname) ||
        page.pathname.match(notePath)?.[1]?.toLowerCase() !== id || page.searchParams.get("source") === "404") {
      return "unavailable";
    }

    const visible = node => node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]');
    const login = Array.from(document.querySelectorAll('.login-modal, .login-container .login-btn, header button, .side-bar button'))
      .some(node => visible(node) && (node.matches(".login-modal") || /^(登录|登入|sign in|log in)$/i.test(node.textContent.trim())));
    if (login) return "unavailable";
    const wrappers = Array.from(document.querySelectorAll(".collect-wrapper")).filter(visible);
    const detail = document.querySelector("#noteContainer");
    const inDetail = detail ? wrappers.filter(node => detail.contains(node)) : [];
    const matching = inDetail.length ? inDetail : wrappers;
    const control = matching.length === 1 ? matching[0] : null;
    const icon = control?.querySelector("svg use");
    const symbol = (icon?.getAttribute("href") || icon?.getAttribute("xlink:href") || "").split("#").pop();
    const state = symbol === "collected" ? "collected" : symbol === "collect" ? "not-collected" : "";
    if (state && state === lastState && !control.matches('[disabled], [aria-disabled="true"]')) {
      if (state !== "collected" || !click) return state;
      control.click();
      await sleep(1000);
      return "clicked";
    }
    lastState = state;
    await sleep(250);
  }
  return "unknown";
}
