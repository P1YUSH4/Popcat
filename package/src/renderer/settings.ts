// Settings window: name the cat, pick an (unlocked) coat, see mood + trophies,
// and set custom Pomodoro / meeting timers. Talks to the overlay cat via the
// preload bridge; reads live status with bridge.getStatus().
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

interface CoatInfo { name: string; label: string; unlocked: boolean; need: string | null; color: string; }
interface AccInfo { name: string; label: string; unlocked: boolean; need: string | null; }
interface Trophy { id: string; title: string; unlocked: boolean; }
interface BondInfo { xp: number; level: number; levelName: string; nextXp: number; dailyCareStreak: number; treatAvailable: boolean; }
interface Status {
  name?: string; coat?: string; accessory?: string; mood?: string; rhythm?: string;
  coats?: CoatInfo[]; accessories?: AccInfo[]; achList?: Trophy[]; bond?: BondInfo;
  achievements?: { unlocked: number; total: number; dailyStreak: number; focusMinToday: number };
}

let nameTouched = false;
document.getElementById("petName")!.addEventListener("input", () => { nameTouched = true; });

function render(s: Status): void {
  const a = s.achievements;
  const b = s.bond;
  document.getElementById("mood")!.textContent =
    `${s.name || "Your cat"} — feeling ${s.mood || "…"}` +
    (a ? `  ·  🔥 ${a.dailyStreak}d streak  ·  🏆 ${a.unlocked}/${a.total}` : "");

  // Bond display
  if (b) {
    const pct = Math.round((b.xp / b.nextXp) * 100);
    document.getElementById("bondInfo")!.textContent = `${b.levelName} (Lv${b.level})  ·  ${b.xp}/${b.nextXp} XP  ·  📅 ${b.dailyCareStreak}d`;
    document.getElementById("bondProgress")!.style.width = `${Math.min(100, pct)}%`;
    const btn = document.getElementById("treatBtn") as HTMLButtonElement;
    btn.disabled = !b.treatAvailable;
    btn.style.opacity = b.treatAvailable ? "1" : "0.5";
    btn.title = b.treatAvailable ? "Give your cat a treat" : "Already gave a treat today";
  }

  if (!nameTouched && s.name) (document.getElementById("petName") as HTMLInputElement).value = s.name;

  // coat swatches
  const coats = s.coats || [];
  const titleById = new Map((s.achList || []).map((t) => [t.id, t.title]));
  const box = document.getElementById("coats")!;
  box.innerHTML = "";
  for (const c of coats) {
    const b = document.createElement("button");
    b.className = "swatch" + (c.name === s.coat ? " sel" : "") + (c.unlocked ? "" : " locked");
    b.style.background = c.color;
    b.title = c.unlocked ? c.label : `${c.label} — locked (earn “${titleById.get(c.need || "") || c.need}”)`;
    if (!c.unlocked) { const lk = document.createElement("span"); lk.className = "lk"; lk.textContent = "🔒"; b.appendChild(lk); }
    if (c.unlocked) b.addEventListener("click", () => { window.bridge.setCoat?.(c.name); });
    box.appendChild(b);
  }

  // accessory chips
  const accBox = document.getElementById("accs")!;
  accBox.innerHTML = "";
  for (const ac of s.accessories || []) {
    const c = document.createElement("button");
    c.className = "chip" + (ac.name === s.accessory ? " sel" : "") + (ac.unlocked ? "" : " locked");
    c.textContent = (ac.unlocked ? "" : "🔒 ") + ac.label;
    c.title = ac.unlocked ? ac.label : `${ac.label} — locked (earn “${titleById.get(ac.need || "") || ac.need}”)`;
    if (ac.unlocked) c.addEventListener("click", () => { window.bridge.setAccessory?.(ac.name); });
    accBox.appendChild(c);
  }

  // trophy pills
  const tro = document.getElementById("trophies")!;
  tro.innerHTML = "";
  for (const t of s.achList || []) {
    const p = document.createElement("span");
    p.className = "tro" + (t.unlocked ? " got" : "");
    p.textContent = (t.unlocked ? "✓ " : "🔒 ") + t.title;
    tro.appendChild(p);
  }
}

async function refresh(): Promise<void> {
  try { const s = await window.bridge.getStatus?.(); if (s) render(s as Status); } catch { /* overlay not ready */ }
}
refresh();
setInterval(refresh, 1500);

document.getElementById("saveName")!.addEventListener("click", () => {
  const name = str("petName", "");
  window.bridge.setName(name);
  nameTouched = false;
  flash("nameOk", name ? `Named ${name} ✓` : "Name cleared ✓");
});

document.getElementById("startPomo")!.addEventListener("click", () => {
  const cfg = { focus: num("focus", 25), brk: num("brk", 5), long: num("long", 15), every: num("every", 4), start: true };
  window.bridge.setPomodoro(cfg);
  flash("pomoOk", `Started — ${cfg.focus}/${cfg.brk} (long ${cfg.long} every ${cfg.every}) ✓`);
});

document.getElementById("setMeeting")!.addEventListener("click", () => {
  const cfg = { mins: Math.max(0, num("mins", 10)), label: str("label", "Meeting") };
  window.bridge.setMeeting(cfg);
  flash("meetOk", cfg.mins > 0 ? `Reminder set in ${cfg.mins} min ✓` : "Reminder set (now) ✓");
});

document.getElementById("treatBtn")!.addEventListener("click", () => {
  window.bridge.giveTreat?.();
  flash("treatOk", "Yum! 💕");
});
