import { Cat } from "./Cat";
import { sound } from "./Sound";
import type { SpriteMeta } from "./types";

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function main(): Promise<void> {
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const meta = (await fetch("assets/sprites/pao.json").then((r) => r.json())) as SpriteMeta;
  const sheet = await loadImage(`assets/sprites/${meta.image}`);

  const cat = new Cat(canvas, sheet, meta);
  window.cat = cat; // expose public API: window.cat.startThinking() / finishThinking()

  // Illustrated (painted) cat: if a cleaned image is bundled, use it instead of
  // the pixel sprite. Optional — the pixel cat is the fallback.
  try {
    const illu = await loadImage("assets/sprites/cat_idle.png");
    cat.setIllustrated(illu);
    console.log("%cPao: illustrated mode 🎨", "color:#7cc4d6");
  } catch { /* no illustrated asset -> pixel mode */ }

  // tray-menu controls (the overlay isn't focusable, so DevTools isn't usable)
  window.bridge.onDo((action) => {
    if (action === "stretch") cat.stretch();
    else if (action === "jump") cat.finishThinking();
    else if (action === "confused") cat.confused();
    else if (action === "angry") cat.angry();
    else if (action === "thinking") cat.thinking();
    else if (action === "answerready") cat.answerReady();
    else if (action === "idle") cat.rest();
    else if (action === "celebrate") cat.celebrate();
    else if (action === "worried") cat.worried();
    else if (action === "hydrate") cat.hydrate();
    else if (action === "pomo:start") cat.startPomodoro();
    else if (action === "pomo:stop") cat.stopPomodoro();
    else if (action === "focus") cat.focusAlert();
    else if (action.startsWith("meeting:")) cat.scheduleMeeting(parseInt(action.split(":")[1], 10) || 0);
    else if (action.startsWith("coat:")) cat.setCoat(action.split(":")[1]);
    else if (action.startsWith("acc:")) cat.setAccessory(action.split(":")[1]);
    else if (action === "throw") cat.tossDemo();
    else if (action === "autonomous:on") cat.setAutonomous(true);
    else if (action === "autonomous:off") cat.setAutonomous(false);
    else if (action === "peek:on") cat.setPeek(true);
    else if (action === "peek:off") cat.setPeek(false);
    else if (action === "mute:on") sound.muted = true;
    else if (action === "mute:off") sound.muted = false;
  });

  // custom timers from the settings window
  window.bridge.onSetPomodoro((cfg) => cat.configurePomodoro(cfg));
  window.bridge.onSetMeeting((cfg) => cat.scheduleMeeting(cfg.mins, cfg.label));
  window.bridge.onSetName?.((name) => cat.setName(name));

  // Render at up to 60fps so continuous MOTION (walking, eye-tracking, throw
  // arcs, squash/stretch) is smooth — sprite frame-stepping is duration-based,
  // but physics/position update per render frame, so the old 33fps cap made
  // movement choppy. The region-only clear keeps the per-frame cost tiny.
  const MIN_DT = 1000 / 60;
  let last = performance.now();
  function frame(now: number): void {
    requestAnimationFrame(frame);
    const elapsed = now - last;
    if (elapsed < MIN_DT) return;            // skip frames faster than the cap
    last = now;
    cat.update(Math.min(0.05, elapsed / 1000)); // clamp dt (tab stalls)
    cat.render();
  }
  requestAnimationFrame(frame);

  // first-run onboarding: greet once, then remember we've said hello
  try {
    if (!localStorage.getItem("pao.onboarded")) {
      localStorage.setItem("pao.onboarded", "1");
      setTimeout(() => cat.welcome(), 1500);
    }
  } catch { /* ignore */ }

  // tiny console helper
  console.log("%cPao is awake 🐾  try: cat.startThinking() / cat.finishThinking()", "color:#7cc4d6");
}

main().catch((err) => console.error("[pao] failed to start", err));
