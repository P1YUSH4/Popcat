// Settings window: lets the user type custom Pomodoro durations + a meeting
// reminder, then sends them to the overlay cat via the preload bridge.
const num = (id: string, def: number): number => {
  const v = parseInt((document.getElementById(id) as HTMLInputElement).value, 10);
  return isNaN(v) ? def : v;
};
const str = (id: string, def: string): string =>
  (document.getElementById(id) as HTMLInputElement).value.trim() || def;

function flash(id: string, msg: string): void {
  const el = document.getElementById(id)!;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 2500);
}

// ---- persisted settings (General + Context) ------------------------------
type Rules = { pattern: string; mode: string }[];
let rules: Rules = [];
const el = (id: string) => document.getElementById(id) as HTMLInputElement;

function renderRules(): void {
  const box = document.getElementById("rules")!;
  box.innerHTML = "";
  rules.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<label>${r.pattern} → ${r.mode}</label>`;
    const x = document.createElement("span");
    x.textContent = "✕"; x.style.cssText = "cursor:pointer;color:#d66;font-weight:bold";
    x.addEventListener("click", () => { rules.splice(i, 1); renderRules(); pushConfig(); });
    row.appendChild(x); box.appendChild(row);
  });
}

function pushConfig(): void {
  window.bridge.setConfig({
    autostart: el("autostart").checked,
    sleepMin: Math.max(1, num("sleepMin", 1)),
    hydrationMin: Math.max(0, num("hydrationMin", 15)),
    leisureNudge: el("leisureNudge").checked,
    contextEnabled: el("contextEnabled").checked,
    sound: { muted: el("muted").checked, volume: num("volume", 100) / 100 },
    contextRules: rules,
  });
}

function loadConfig(cfg: import("./types").PaoConfig): void {
  el("autostart").checked = cfg.autostart;
  el("sleepMin").value = String(cfg.sleepMin);
  el("hydrationMin").value = String(cfg.hydrationMin);
  el("leisureNudge").checked = cfg.leisureNudge;
  el("contextEnabled").checked = cfg.contextEnabled;
  el("muted").checked = cfg.sound.muted;
  el("volume").value = String(Math.round(cfg.sound.volume * 100));
  rules = cfg.contextRules || [];
  renderRules();
}

for (const id of ["autostart", "sleepMin", "hydrationMin", "leisureNudge", "contextEnabled", "muted", "volume"]) {
  document.getElementById(id)!.addEventListener("change", pushConfig);
}
document.getElementById("addRule")!.addEventListener("click", () => {
  const pattern = el("rulePattern").value.trim();
  if (!pattern) return;
  rules.push({ pattern, mode: el("ruleMode").value });
  el("rulePattern").value = "";
  renderRules(); pushConfig();
});

window.bridge.getConfig().then(loadConfig);
window.bridge.onConfig(loadConfig);

document.getElementById("startPomo")!.addEventListener("click", () => {
  const cfg = { focus: num("focus", 25), brk: num("brk", 5), long: num("long", 15), every: num("every", 4), start: true };
  window.bridge.setPomodoro(cfg);
  flash("pomoOk", `Started — ${cfg.focus}/${cfg.brk} (long ${cfg.long} every ${cfg.every}) ✓`);
});

const modeEl = document.getElementById("mode") as HTMLSelectElement;
function syncMode(): void {
  const atMode = modeEl.value === "at";
  (document.getElementById("rowIn") as HTMLElement).style.display = atMode ? "none" : "flex";
  (document.getElementById("rowAt") as HTMLElement).style.display = atMode ? "flex" : "none";
}
modeEl.addEventListener("change", syncMode);
syncMode();

document.getElementById("setMeeting")!.addEventListener("click", () => {
  const label = str("label", "Meeting");
  const preMin = Math.max(0, num("preMin", 5));
  if (modeEl.value === "at") {
    const t = (document.getElementById("at") as HTMLInputElement).value || "00:00";
    const [hh, mm] = t.split(":").map((n) => parseInt(n, 10));
    const d = new Date();
    d.setHours(hh || 0, mm || 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   // next day if past
    window.bridge.setMeeting({ atMs: d.getTime(), label, preMin });
    flash("meetOk", `Reminder set for ${t} ✓`);
  } else {
    const mins = Math.max(0, num("mins", 10));
    window.bridge.setMeeting({ mins, label, preMin });
    flash("meetOk", mins > 0 ? `Reminder in ${mins} min ✓` : "Reminder set (now) ✓");
  }
});
