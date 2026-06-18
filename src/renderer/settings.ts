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
