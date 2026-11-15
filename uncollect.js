import { source, xhsHosts, xhsNotePath } from "./model.js";

const failures = {
  "unavailable": "小红书没有打开这条原帖，可能是链接过期或笔记不可见。",
  "login": "小红书原帖要求登录，请在打开的标签页登录后再试。",
  "unknown": "原帖已打开，但拾读未能识别小红书的收藏按钮。",
  "confirmation-needed": "小红书打开了确认窗口，请在原帖处理。",
  "collected": "小红书刷新后仍显示已收藏。请在打开的原帖检查收藏状态。"
};

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
      if (typeof reload === "string") {
        browser.tabs.update(tabId, { url: reload }).catch(reject);
      } else if (reload) {
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

async function findOpenNote(browser, noteId) {
  const [[active], candidates] = await Promise.all([
    browser.tabs.query({ active: true, lastFocusedWindow: true }),
    browser.tabs.query({ url: xhsHosts.map(host => `https://${host}/*`) })
  ]);
  const matching = candidates.filter(tab => {
    if (tab.id == null || Boolean(tab.incognito) !== Boolean(active?.incognito)) return false;
    const url = tab.pendingUrl || tab.url;
    return source(url)?.id === noteId && new URL(url).searchParams.get("source") !== "404";
  });
  return matching.find(tab => tab.id === active?.id) ||
    matching.find(tab => tab.windowId === active?.windowId) ||
    matching[0];
}

const connectionError = "Chrome 未能连接小红书原帖。已尝试备用原帖地址，请检查网页连接后重试。";

function alternativeUrls(original) {
  const url = new URL(original.url);
  const canonical = new URL(url);
  canonical.pathname = `/explore/${original.id}`;
  const alternate = new URL(canonical);
  alternate.hostname = url.hostname === "www.xiaohongshu.com" ? "xiaohongshu.com" : "www.xiaohongshu.com";
  return [...new Set([alternate.href, canonical.href])].filter(link => link !== original.url);
}

function readOriginalLocation(id, hosts, notePattern) {
  const page = new URL(location.href);
  return page.protocol === "https:" && hosts.includes(page.hostname) &&
    new RegExp(notePattern, "i").exec(page.pathname)?.[1]?.toLowerCase() === id &&
    page.searchParams.get("source") !== "404";
}

async function openNote(browser, original, activateExisting) {
  const existing = await findOpenNote(browser, original.id);
  const tab = existing || await browser.tabs.create({ url: original.url, active: true });
  if (existing && (activateExisting || existing.discarded)) {
    await browser.tabs.update(tab.id, { active: true });
  }
  const alternatives = alternativeUrls(original);
  let sawDocument = false;
  for (const candidate of [null, ...alternatives]) {
    try {
      if (candidate) await loadTab(browser, tab.id, candidate);
      else await loadTab(browser, tab.id);
      const [frame] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: readOriginalLocation,
        args: [original.id, xhsHosts, xhsNotePath.source]
      });
      if (frame?.result) return { tab, existing };
      sawDocument = true;
      const { url } = await browser.tabs.get(tab.id);
      if (url && !xhsHosts.includes(new URL(url).hostname)) throw new Error("小红书跳转了页面，请在原帖标签页检查登录或访问状态。");
      if (url && /login|captcha|verify/i.test(new URL(url).pathname)) {
        throw new Error("小红书要求登录或验证，请在原帖标签页按网站提示处理。");
      }
    } catch (error) {
      if (!/error page|net::ERR_|cannot access a chrome|chrome-error|加载超时/i.test(error.message)) throw error;
    }
  }
  throw new Error(sawDocument ? "小红书没有显示这条原帖，可能是链接过期或笔记不可见。" : connectionError);
}

export async function openOriginal(browser, item) {
  const original = source(item?.url);
  if (!original || original.id !== item.id) throw new Error("这条记录没有可用的原帖地址。");
  if (original.id.startsWith("share:")) {
    await browser.tabs.create({ url: original.url, active: true });
  } else {
    await openNote(browser, original, true);
  }
}

export async function uncollect(browser, item) {
  const original = source(item?.url);
  if (!original || original.id !== item.id || original.id.startsWith("share:")) {
    throw new Error("这条记录缺少可验证的原帖地址。请从收藏页重新导入它。");
  }

  const { tab, existing } = await openNote(browser, original, false);
  let verified = false;
  const check = async click => {
    try {
      const [frame] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: readFavoriteControl,
        args: [item.id, xhsHosts, xhsNotePath.source, click]
      });
      return frame?.result;
    } catch (error) {
      if (/error page|net::ERR_|chrome-error/i.test(error.message)) {
        throw new Error("确认收藏状态时连接断开。拾读已保留这条记录，请检查原帖后再试。");
      }
      throw error;
    }
  };
  try {
    let before = await check(true);
    if (existing && before === "not-collected") {
      await loadTab(browser, tab.id, true);
      before = await check(true);
    }
    if (before === "not-collected") {
      verified = true;
      return "already-removed";
    }
    if (before !== "clicked") throw new Error(failures[before] || failures.unknown);

    await loadTab(browser, tab.id, true);
    const after = await check(false);
    if (after !== "not-collected") throw new Error(failures[after] || failures.unknown);
    verified = true;
    return "removed";
  } finally {
    if (verified && !existing) await browser.tabs.remove(tab.id).catch(() => {});
  }
}

// Injected into the original note. Only an explicitly selected collection control may be clicked.
export async function readFavoriteControl(id, hosts, notePattern, click) {
  const notePath = new RegExp(notePattern, "i");
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = node => node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]');
  const tag = node => (node.textContent || "").trim();

  function correctNote() {
    const page = new URL(location.href);
    return page.protocol === "https:" && hosts.includes(page.hostname) &&
      page.pathname.match(notePath)?.[1]?.toLowerCase() === id && page.searchParams.get("source") !== "404";
  }

  function controlAndState() {
    const wrappers = Array.from(document.querySelectorAll(".collect-wrapper")).filter(visible);
    const detail = document.querySelector("#noteContainer");
    const inDetail = detail ? wrappers.filter(node => detail.contains(node)) : [];
    const buttonSelector = 'button[aria-label="收藏"], button[aria-label="取消收藏"], [data-testid="collect-button"]';
    const buttons = inDetail.length ? inDetail : wrappers.length ? wrappers :
      Array.from((detail || document).querySelectorAll(buttonSelector)).filter(visible);
    const control = buttons.length === 1 ? buttons[0] : null;
    if (!control || control.matches('[disabled], [aria-disabled="true"]')) return {};
    const icon = control.querySelector("svg use");
    const symbol = (icon?.getAttribute("href") || icon?.getAttribute("xlink:href") || "").split("#").pop();
    const pressed = control.getAttribute("aria-pressed") || control.querySelector("[aria-pressed]")?.getAttribute("aria-pressed");
    const state = symbol === "collected" || (!symbol && pressed === "true") ? "collected" :
      symbol === "collect" || (!symbol && pressed === "false") ? "not-collected" : "";
    return { control, state };
  }

  let lastState = "", stable = 0;
  for (let attempt = 0; attempt < 22; attempt++) {
    if (!correctNote()) return "unavailable";
    const login = Array.from(document.querySelectorAll('.login-modal, .login-container .login-btn, header button, .side-bar button'))
      .some(node => visible(node) && (node.matches(".login-modal") || /^(登录|登入|sign in|log in)$/i.test(tag(node))));
    if (login) return "login";
    const { control, state } = controlAndState();
    stable = state && state === lastState ? stable + 1 : 0;
    lastState = state;
    if (stable >= 2) {
      if (state !== "collected" || !click) return state;
      // Click the interactive element used by the site's own note UI exactly once.
      const target = control.matches('button, [role=button]') ? control :
        control.querySelector('button, [role=button], svg') || control;
      target.click ? target.click() : target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      let confirmed = false;
      for (let tick = 0; tick < 18; tick++) {
        await sleep(200);
        if (!correctNote()) return "unavailable";
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .reds-modal, .el-dialog')).filter(visible);
        for (const dialog of dialogs) {
          if (!/(取消收藏|取消收藏這則|remove from (?:saved|favorites))/i.test(tag(dialog))) continue;
          const actions = Array.from(dialog.querySelectorAll('button, [role=button]')).filter(node =>
            visible(node) && /^(确定|確定|确认|確認|确认取消收藏|取消收藏|remove|confirm)$/i.test(tag(node)));
          if (!confirmed && actions.length === 1) {
            actions[0].click();
            confirmed = true;
          } else if (!confirmed) {
            return "confirmation-needed";
          }
        }
        if (controlAndState().state === "not-collected") {
          await sleep(200);
          return "clicked";
        }
      }
      return "clicked";
    }
    await sleep(stable ? 140 : 250);
  }
  return "unknown";
}
