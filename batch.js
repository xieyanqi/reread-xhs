export const batchLimit = 1000;
export const restrictedMessage = "小红书显示安全限制（300013）。已停止访问操作。请按小红书页面提示处理。";

export function batchRows(scan) {
  const start = scan?.batchStart ?? 0;
  return (scan?.rows ?? []).slice(start, start + batchLimit);
}

export function batchIds(scan) {
  return new Set(batchRows(scan).map(row => row.id).filter(Boolean));
}

export function batchItems(items, scan) {
  const ids = batchIds(scan);
  return items.filter(item => ids.has(item.id));
}

// This function is also passed directly to Chrome's script injector.
export function siteRestricted() {
  const body = document.body?.textContent || "";
  return /安全限制|检测到异常访问/.test(body) && /300013|本次访问已被限制/.test(body);
}
