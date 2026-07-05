// Local-only usage stats. Everything lives in localStorage — no network.
const KEY = "wisprgemma-stats-v1";

export function loadStats() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? [];
  } catch {
    return [];
  }
}

// entry: { ts, mode, audioSec, firstTokenMs, totalMs, words }
export function logUtterance(entry) {
  const all = loadStats();
  all.push(entry);
  // keep the log bounded (~1 year of heavy use)
  if (all.length > 20000) all.splice(0, all.length - 20000);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function clearStats() {
  localStorage.removeItem(KEY);
}

export function countWords(text) {
  return (text.trim().match(/\S+/g) ?? []).length;
}
