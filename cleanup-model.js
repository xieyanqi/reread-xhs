import { localDay, source } from "./model.js";

export const stages = ["expiry", "topics", "quick"];
export const roundSize = 20;

const topicRules = [
  ["学习与考试", /考试|考研|雅思|托福|背单词|备考|复习|课程|学习方法|选课/],
  ["留学与申请", /留学|文书|网申|面试申请|保研|申请季|研究生申请|奖学金|硕士申请/],
  ["求职与实习", /简历|找工作|求职|实习|校招|工作面试|社招|远程兼职/],
  ["旅行与住宿", /旅游|旅行|机票|酒店|民宿|住宿|景点|行程|自由行/],
  ["租房与搬家", /租房|转租|找房|看房|租约|押金|合租|整租|搬家/],
  ["食谱与餐厅", /餐厅|探店|食谱|菜谱|菜单|美食|烘焙|做饭|咖啡店/],
  ["香水与香氛", /香水|香氛|淡香精|试香|香评|留香|香调|香薰/],
  ["穿搭与购物", /穿搭|搭配|平替|购物|买衣服|衣柜|秋冬装|通勤鞋|试穿/],
  ["影视与阅读", /书单|读书|电影|追剧|片单|纪录片|书评|观影/],
  ["运动与训练", /健身|训练计划|瑜伽|跑步|运动|力量训练|热身|拉伸/],
  ["工具与效率", /工具推荐|软件|快捷键|效率|自动化|插件|笔记工具|教程/],
  ["优惠与推广", /领券|优惠券|折扣|限时优惠|拼团|返现|种草清单|满减|推广/]
];

const timedTitle = /活动|优惠|报名|领券|发售|促销|门票|展览|招募|开售|讲座|直播|折扣|截至|截止|展会|市集/;
const recurringTitle = /每天|每周|每月|每年|长期|常年|往期|回顾|复盘|合集/;

export function expiryDate(title, today = localDay()) {
  if (!timedTitle.test(title) || recurringTitle.test(title)) return "";
  const datePattern = /(?<!\d)(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?(?!\d)/g;
  const matches = [...title.matchAll(datePattern)];
  if (!matches.length || matches.length > 2) return "";
  const dates = [];
  for (const [, year, month, day] of matches) {
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (date.getFullYear() !== Number(year) || date.getMonth() + 1 !== Number(month) ||
        date.getDate() !== Number(day)) return "";
    dates.push(localDay(date));
  }
  const remaining = title.replace(datePattern, "");
  if (/(?:\d{1,2}\s*月\s*\d{1,2}\s*日?|\d{1,2}[-/.]\d{1,2}|(?:至|到|—|~|～)\s*\d)/.test(remaining)) return "";
  const latest = dates.sort().at(-1);
  return latest < today ? latest : "";
}

export function protectedItem(item) {
  return Boolean(item?.body || item?.history?.length || item?.kind === "note" || item?.kind === "action");
}

export function canUncollect(item) {
  const id = source(item.url)?.id;
  return id === item.id && !id.startsWith("share:");
}

export function availableItems(items, preferences, stage) {
  const kept = new Set(preferences.kept || []);
  const skipped = new Set(preferences.skipped?.[stage] || []);
  return items.filter(item => item.status === "open" && !item.favoriteRemoved && !item.reviewRemoved &&
    !kept.has(item.id) && !skipped.has(item.id));
}

export function topicGroups(items, dismissed = []) {
  const hidden = new Set(dismissed);
  const groups = topicRules.filter(([label]) => !hidden.has(label)).map(([label, matcher]) => ({
    label,
    candidates: items.flatMap(item => {
      const match = item.title?.match(matcher)?.[0];
      return match ? [{ item, reason: `标题提到「${match}」` }] : [];
    })
  }));
  return groups.filter(group => group.candidates.length >= 3)
    .sort((a, b) => b.candidates.length - a.candidates.length).slice(0, 5);
}

export function selectRound(items) {
  return items.filter(item => !protectedItem(item)).slice(0, roundSize).map(item => item.id);
}
