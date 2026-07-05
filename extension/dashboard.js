import { loadStats, clearStats } from "./stats.js";

const BAR_COLOR = "#3553ff"; // forms-ai chart-1 (light), validated vs #ffffff surface
const TYPING_WPM = 40;

const $ = (id) => document.getElementById(id);
const entries = loadStats();

$("clear-btn").addEventListener("click", () => {
  if (confirm("Delete all locally stored dictation stats?")) {
    clearStats();
    location.reload();
  }
});

// ---------- aggregates ----------

function renderTiles(all) {
  const words = all.reduce((s, e) => s + e.words, 0);
  const speakSec = all.reduce((s, e) => s + e.audioSec, 0);
  const modelSec = all.reduce((s, e) => s + e.totalMs / 1000, 0);
  const avgFirst = all.reduce((s, e) => s + e.firstTokenMs, 0) / all.length;
  const wpm = speakSec > 0 ? words / (speakSec / 60) : 0;
  const savedMin = words / TYPING_WPM - (speakSec + modelSec) / 60;

  $("t-words").textContent = words.toLocaleString();
  $("t-utterances").textContent = all.length.toLocaleString();
  $("t-wpm").textContent = wpm ? Math.round(wpm) : "–";
  $("t-saved").textContent = savedMin > 0 ? formatMin(savedMin) : "0 min";
  $("t-first").textContent = `${(avgFirst / 1000).toFixed(1)}s`;
  $("t-streak").textContent = streak(all);
}

function formatMin(min) {
  return min >= 90 ? `${(min / 60).toFixed(1)} h` : `${Math.round(min)} min`;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function streak(all) {
  const days = new Set(all.map((e) => dayKey(e.ts)));
  let n = 0;
  const d = new Date();
  // today counts if present; otherwise start from yesterday
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d.getTime()))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function dailyBuckets(all, nDays) {
  const byDay = new Map();
  for (const e of all) {
    const k = dayKey(e.ts);
    const b = byDay.get(k) ?? { words: 0, count: 0 };
    b.words += e.words;
    b.count += 1;
    byDay.set(k, b);
  }
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - (nDays - 1));
  for (let i = 0; i < nDays; i++) {
    const k = dayKey(d.getTime());
    const b = byDay.get(k) ?? { words: 0, count: 0 };
    out.push({
      key: k,
      label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      ...b,
    });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// ---------- chart (single series → no legend; hover tooltip per bar) ----------

function renderChart(days) {
  const W = 700, H = 220;
  const pad = { top: 12, right: 8, bottom: 26, left: 40 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;
  const max = Math.max(1, ...days.map((d) => d.words));
  const step = iw / days.length;
  const barW = Math.min(28, step - 2); // ≥2px gap between adjacent bars

  const yTicks = niceTicks(max, 4);
  const y = (v) => pad.top + ih - (v / yTicks.at(-1)) * ih;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

  // recessive grid + y labels
  for (const t of yTicks) {
    svg += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${y(t)}" y2="${y(t)}" stroke="rgba(43,41,38,0.08)" stroke-width="1"/>`;
    svg += `<text x="${pad.left - 8}" y="${y(t) + 3}" text-anchor="end" font-size="10" fill="#6b6a66">${t}</text>`;
  }

  days.forEach((d, i) => {
    const x = pad.left + i * step + (step - barW) / 2;
    const yTop = y(d.words);
    const h = pad.top + ih - yTop;
    if (d.words > 0) {
      // rounded top corners (4px), flat baseline
      const r = Math.min(4, barW / 2, h);
      svg += `<path class="bar" data-i="${i}" fill="${BAR_COLOR}" d="M${x},${yTop + r}
        a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r}
        v${h - r} h${-barW} Z"/>`;
    }
    // invisible full-height hit target (bigger than the mark)
    svg += `<rect class="hit" data-i="${i}" x="${pad.left + i * step}" y="${pad.top}" width="${step}" height="${ih}" fill="transparent"/>`;
    // x labels: every other day to avoid collisions
    if (i % 2 === 0) {
      svg += `<text x="${pad.left + i * step + step / 2}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#6b6a66">${d.label}</text>`;
    }
  });
  svg += "</svg>";

  const chart = $("chart");
  chart.innerHTML = svg;

  // hover tooltip
  const tip = $("tooltip");
  chart.addEventListener("pointermove", (e) => {
    const hit = e.target.closest(".hit, .bar");
    if (!hit) { tip.hidden = true; return; }
    const d = days[+hit.dataset.i];
    tip.innerHTML = `<b>${d.label}</b><br>${d.words.toLocaleString()} words · ${d.count} dictation${d.count === 1 ? "" : "s"}`;
    tip.hidden = false;
    const panel = chart.closest(".panel").getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - panel.left + 12, panel.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY - panel.top - 40}px`;
  });
  chart.addEventListener("pointerleave", () => (tip.hidden = true));

  // table view (accessibility / exact values)
  const tbody = $("data-table").querySelector("tbody");
  tbody.innerHTML = days
    .map((d) => `<tr><td>${d.label}</td><td>${d.words.toLocaleString()}</td><td>${d.count}</td></tr>`)
    .join("");
  $("table-toggle").addEventListener("click", (e) => {
    const pressed = e.target.getAttribute("aria-pressed") === "true";
    e.target.setAttribute("aria-pressed", String(!pressed));
    $("data-table").hidden = pressed;
    chart.hidden = !pressed;
  });
}

function niceTicks(max, maxTicks) {
  // smallest 1/2/5×10^k step that needs at most maxTicks+1 intervals,
  // so the top gridline hugs the data instead of doubling past it
  for (let mag = 1; ; mag *= 10) {
    for (const m of [1, 2, 5]) {
      const step = m * mag;
      const count = Math.ceil(max / step);
      if (count <= maxTicks + 1) {
        return Array.from({ length: count + 1 }, (_, i) => i * step);
      }
    }
  }
}

// ---------- output styles breakdown ----------

const MODE_NAMES = {
  clean: "Clean dictation",
  verbatim: "Verbatim transcript",
  email: "Polished email",
  english: "Any language → English",
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderModes(all) {
  const counts = new Map();
  for (const e of all) counts.set(e.mode, (counts.get(e.mode) ?? 0) + 1);
  const max = Math.max(...counts.values());
  $("modes").innerHTML = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([mode, n]) =>
        `<li><span class="name">${MODE_NAMES[mode] ?? esc(mode)}</span>
         <span class="bar" style="width:${(n / max) * 160}px"></span>
         <span class="count">${n}</span></li>`
    )
    .join("");
}

// ---------- boot ----------

if (entries.length === 0) {
  $("empty").hidden = false;
} else {
  $("content").hidden = false;
  renderTiles(entries);
  renderChart(dailyBuckets(entries, 14));
  renderModes(entries);
}
