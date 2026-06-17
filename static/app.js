/* Quant Terminal frontend — polls the reporter API and renders one bot. */

const POLL_MS = 3000;
const BOTS_POLL_MS = 30000; // the bot list changes rarely — refresh it far less often
const $ = (id) => document.getElementById(id);

let selectedBot = localStorage.getItem("selectedBot") || null;
let lastDashboard = null;
let lastBotsLoad = 0;

/* ---------------------------------------------------------- bots picker */

async function loadBots() {
  const res = await fetch("/api/bots");
  if (!res.ok) throw new Error(`GET /api/bots -> ${res.status}`);
  const bots = await res.json();

  const sel = $("bot-select");
  const prev = sel.value;
  sel.innerHTML = "";
  if (bots.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "— no bots reporting yet —";
    opt.value = "";
    sel.appendChild(opt);
    return null;
  }
  // group into Bots vs Watchers so the dropdown is easier to scan
  const groups = { Bots: document.createElement("optgroup"),
                   Watchers: document.createElement("optgroup") };
  groups.Bots.label = "Bots";
  groups.Watchers.label = "Watchers";
  for (const b of bots) {
    const isWatcher = /watch/i.test(b.bot_id) || /watch/i.test(b.name);
    const opt = document.createElement("option");
    opt.value = b.bot_id;
    opt.textContent = `${b.online ? "●" : "○"} ${b.name}`;
    (isWatcher ? groups.Watchers : groups.Bots).appendChild(opt);
  }
  for (const label of ["Bots", "Watchers"]) {
    if (groups[label].children.length) sel.appendChild(groups[label]);
  }
  if (!selectedBot || !bots.some((b) => b.bot_id === selectedBot)) {
    selectedBot = bots[0].bot_id;
  }
  sel.value = selectedBot;
  if (prev !== sel.value) localStorage.setItem("selectedBot", selectedBot);
  return bots.find((b) => b.bot_id === selectedBot);
}

$("bot-select").addEventListener("change", (e) => {
  selectedBot = e.target.value;
  localStorage.setItem("selectedBot", selectedBot);
  refresh();
});

/* ---------------------------------------------------------- rendering */

function fmtPnl(v) {
  const sign = v > 0 ? "+" : "";
  return sign + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPrice(v) {
  if (v === null || v === undefined) return "—";
  const digits = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 4 : 6;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
}

function setPnl(el, v) {
  el.textContent = fmtPnl(v);
  el.classList.toggle("pos", v > 0);
  el.classList.toggle("neg", v < 0);
}

function renderStats(d) {
  setPnl($("stat-total-pnl"), d.stats.total_pnl);
  setPnl($("stat-daily-pnl"), d.stats.daily_pnl);
  $("stat-trades").textContent = d.stats.trades_today;
  $("stat-skips").textContent = d.stats.skips_today;

  $("asset-label").textContent = d.bot.asset;
  $("chart-asset").textContent = d.bot.asset ? `· ${d.bot.asset}` : "";
  $("status-dot").className = "status-dot " + (d.bot.online ? "online" : "offline");

  const last = d.prices.length ? d.prices[d.prices.length - 1].price : null;
  $("last-price").textContent = last !== null ? fmtPrice(last) : "";
}

function sideClass(side) {
  const s = (side || "").toUpperCase();
  if (s === "SETTLE") return "";
  if (["BUY", "UP", "YES", "LONG"].includes(s) || s.startsWith("B")) return "side-buy";
  if (["SELL", "DOWN", "NO", "SHORT"].includes(s)) return "side-sell";
  return "";
}

function resultBadge(t) {
  const st = t.status || (t.settled ? "even" : "open");
  const cls = st === "won" ? "won" : st === "lost" ? "lost" : st === "open" ? "open" : "even";
  const note = t.note ? ` <span class="note">${esc(t.note)}</span>` : "";
  return `<span class="badge ${cls}">${st.toUpperCase()}</span>${note}`;
}

function renderTrades(d) {
  const body = $("trades-body");
  $("trade-count").textContent = d.trades.length ? `${d.trades.length} trades` : "";
  if (d.trades.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="empty">no trades yet today</td></tr>`;
    return;
  }
  body.innerHTML = d.trades
    .map((t) => {
      const pnlCls = t.settled ? (t.pnl > 0 ? "pnl-pos" : t.pnl < 0 ? "pnl-neg" : "") : "";
      const pnl = t.settled ? fmtPnl(t.pnl) : "—";
      return `<tr>
        <td>${fmtTime(t.ts)}</td>
        <td class="${sideClass(t.side)}">${esc(t.side || "—")}</td>
        <td>${fmtPrice(t.price)}</td>
        <td>${t.size ?? "—"}</td>
        <td class="${pnlCls}">${pnl}</td>
        <td>${resultBadge(t)}</td>
      </tr>`;
    })
    .join("");
}

function renderSkips(d) {
  const body = $("skips-body");
  const reasons = d.stats.skip_reasons || [];
  $("skip-total").textContent = d.stats.skips_today ? `${d.stats.skips_today} total` : "";
  if (reasons.length === 0) {
    body.innerHTML = `<div class="empty">no skips yet today</div>`;
    return;
  }
  const max = Math.max(...reasons.map((r) => r.count));
  body.innerHTML = reasons
    .map((r) => {
      const pct = max ? Math.round((r.count / max) * 100) : 0;
      return `<div class="skip-row">
        <span class="skip-reason">${esc(r.reason)}</span>
        <span class="skip-bar"><span class="skip-bar-fill" style="width:${pct}%"></span></span>
        <span class="skip-count">${r.count}</span>
      </div>`;
    })
    .join("");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------------------------------------------- price chart */

function drawChart(prices) {
  const canvas = $("price-chart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!prices || prices.length < 2) {
    ctx.fillStyle = "#8d7fab";
    ctx.font = "13px monospace";
    ctx.textAlign = "center";
    ctx.fillText("waiting for price data…", w / 2, h / 2);
    return;
  }

  const padL = 10, padR = 78, padT = 14, padB = 26;
  const vals = prices.map((p) => p.price);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.08;
  max += span * 0.08;

  const X = (i) => padL + (i / (prices.length - 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);

  // horizontal gridlines + price labels
  ctx.font = "11px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const gridN = 4;
  for (let g = 0; g <= gridN; g++) {
    const v = min + ((max - min) * g) / gridN;
    const y = Y(v);
    ctx.strokeStyle = "rgba(168, 85, 247, 0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR + 8, y);
    ctx.stroke();
    ctx.fillStyle = "#8d7fab";
    ctx.fillText(fmtPrice(v), w - padR + 14, y);
  }

  // time labels: first + last
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#8d7fab";
  ctx.textAlign = "left";
  ctx.fillText(fmtTime(prices[0].ts), padL, h - 8);
  ctx.textAlign = "right";
  ctx.fillText(fmtTime(prices[prices.length - 1].ts), w - padR + 8, h - 8);

  // area fill under the line
  const fill = ctx.createLinearGradient(0, padT, 0, h - padB);
  fill.addColorStop(0, "rgba(168, 85, 247, 0.28)");
  fill.addColorStop(1, "rgba(168, 85, 247, 0.0)");
  ctx.beginPath();
  ctx.moveTo(X(0), Y(prices[0].price));
  for (let i = 1; i < prices.length; i++) ctx.lineTo(X(i), Y(prices[i].price));
  ctx.lineTo(X(prices.length - 1), h - padB);
  ctx.lineTo(X(0), h - padB);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  // the line itself, with glow
  const stroke = ctx.createLinearGradient(padL, 0, w - padR, 0);
  stroke.addColorStop(0, "#7c3aed");
  stroke.addColorStop(1, "#c084fc");
  ctx.beginPath();
  ctx.moveTo(X(0), Y(prices[0].price));
  for (let i = 1; i < prices.length; i++) ctx.lineTo(X(i), Y(prices[i].price));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(168, 85, 247, 0.7)";
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // last-price dot
  const lx = X(prices.length - 1);
  const ly = Y(prices[prices.length - 1].price);
  ctx.beginPath();
  ctx.arc(lx, ly, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#e9d5ff";
  ctx.shadowColor = "#c084fc";
  ctx.shadowBlur = 14;
  ctx.fill();
  ctx.shadowBlur = 0;
}

new ResizeObserver(() => {
  if (lastDashboard) drawChart(lastDashboard.prices);
}).observe($("price-chart").parentElement);

/* ---------------------------------------------------------- polling */

async function refresh() {
  try {
    // The bot-list query is cheap but redundant every 3s; refresh it on its own
    // slower cadence and reuse the selected bot in between.
    const now = Date.now();
    if (now - lastBotsLoad >= BOTS_POLL_MS || !selectedBot) {
      lastBotsLoad = now;
      const bot = await loadBots();
      if (!bot) {
        $("footer-status").textContent = "no bots reporting yet — run demo_bot.py or wire reporter.py into a bot";
        return;
      }
    }
    const res = await fetch(`/api/bots/${encodeURIComponent(selectedBot)}/dashboard?points=900`);
    if (!res.ok) throw new Error(`dashboard -> ${res.status}`);
    const d = await res.json();
    lastDashboard = d;
    renderStats(d);
    renderTrades(d);
    renderSkips(d);
    drawChart(d.prices);
    $("footer-status").textContent =
      `last update ${new Date().toLocaleTimeString([], { hour12: false })} · day resets 00:00 UTC`;
  } catch (err) {
    $("footer-status").textContent = `connection error: ${err.message}`;
  }
}

refresh();
setInterval(() => {
  // Don't poll the VPS while the tab is backgrounded — nobody's looking.
  if (!document.hidden) refresh();
}, POLL_MS);

// Refresh immediately when the tab becomes visible again so it's never stale.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

/* ---------------------------------------------------------- card select */

document.querySelectorAll(".stat-card").forEach((card) => {
  card.addEventListener("click", () => {
    const was = card.classList.contains("selected");
    document.querySelectorAll(".stat-card").forEach((c) => c.classList.remove("selected"));
    if (!was) card.classList.add("selected");
  });
});

/* ---------------------------------------------------------- cursor FX */

const glow = $("cursor-glow");
const cursorDot = $("cursor-dot");
let mouseX = innerWidth / 2, mouseY = innerHeight / 2;
let glowX = mouseX, glowY = mouseY;
let lastTrail = 0;

addEventListener("mousemove", (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  glow.style.opacity = "1";
  cursorDot.style.left = e.clientX + "px";
  cursorDot.style.top = e.clientY + "px";
  cursorDot.style.opacity = "1";

  const now = performance.now();
  if (now - lastTrail > 40) {
    lastTrail = now;
    const dot = document.createElement("div");
    dot.className = "cursor-trail";
    dot.style.left = e.clientX + "px";
    dot.style.top = e.clientY + "px";
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 700);
  }
});

addEventListener("mouseleave", () => {
  glow.style.opacity = "0";
  cursorDot.style.opacity = "0";
});

(function animateGlow() {
  glowX += (mouseX - glowX) * 0.12;
  glowY += (mouseY - glowY) * 0.12;
  glow.style.left = glowX + "px";
  glow.style.top = glowY + "px";
  requestAnimationFrame(animateGlow);
})();
