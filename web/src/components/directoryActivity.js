import {activityLabel, activityState} from "../conversationActivity.js";

// Organization is resolved only with stable IDs, never display paths.
export function directoryActivitySummaries(items, folders) {
  const parents = new Map(folders.map(folder => [String(folder.folderId), String(folder.parentId || "")]));
  const summaries = new Map();
  const add = (group, label) => group.labels.set(label, (group.labels.get(label) || 0) + 1);
  for (const item of new Map(items.map(item => [item.conversationUuid, item])).values()) {
    if (item.archived || (!item.running && !item.activityUnread)) continue;
    const ids = [], seen = new Set();
    let id = String(item.folderId || "");
    if (!id) ids.push("__temporary");
    while (id && !seen.has(id)) { seen.add(id); ids.push(id); id = parents.get(id) || ""; }
    const state = activityState(item);
    for (const folderId of ids) {
      if (!summaries.has(folderId)) summaries.set(folderId, {
        waiting: {count: 0, labels: new Map()}, running: {count: 0, labels: new Map()}, unread: {count: 0, labels: new Map()},
      });
      const summary = summaries.get(folderId);
      if (state === "waiting") {
        summary.waiting.count += 1;
        for (const pending of item.activityPending?.length ? item.activityPending : [null]) {
          add(summary.waiting, activityLabel({...item, activityPending: pending ? [pending] : []}));
        }
      } else if (item.running) { summary.running.count += 1; add(summary.running, activityLabel(item)); }
      if (item.activityUnread) {
        summary.unread.count += 1;
        // An unread earlier result can coexist with a new running/waiting turn.
        const result = item.activityResult?.status;
        add(summary.unread, result ? activityLabel({activityState: result}) : item.running ? "未读" : activityLabel(item));
      }
    }
  }
  for (const summary of summaries.values()) {
    for (const [key, name] of [["waiting", "等待处理"], ["running", "运行中"], ["unread", "未读"]]) {
      const group = summary[key];
      group.text = group.count ? `${name} ${group.count} 个会话（${[...group.labels].map(([label, count]) => `${label} ${count}`).join("、")}）` : "";
    }
    summary.text = [summary.waiting.text, summary.running.text, summary.unread.text].filter(Boolean).join("；");
  }
  return summaries;
}
