// Maps the focused app + window title to a behavior "mode". Pure & testable.
// Browsers put the page title in the window title, so sites (LeetCode, YouTube,
// Claude…) are detectable from the title alone.

export type Mode = "focus" | "coding" | "ai" | "leisure" | "neutral";

const RULES: { mode: Mode; re: RegExp }[] = [
  // deep-work problem solving -> focus mode (cat goes quiet)
  { mode: "focus", re: /leetcode|hackerrank|codeforces|codechef|codewars|hackerearth|geeksforgeeks|codingame|exercism|advent of code|kattis|topcoder|spoj|project euler/i },
  // AI assistants
  { mode: "ai", re: /\bclaude\b|chatgpt|openai|copilot|gemini|perplexity|\bbard\b|huggingface|cursor/i },
  // editors / IDEs / terminals + dev tools & sites (treated as "work")
  { mode: "coding", re: /visual studio code|vs ?code|\bide\b|intellij|pycharm|webstorm|phpstorm|goland|clion|rider|datagrip|android studio|xcode|sublime text|notepad\+\+|neovim|\bnvim\b|\bvim\b|emacs|windows ?terminal|powershell|\bpwsh\b|cmd\.exe|conemu|cmder|alacritty|wezterm|kitty|iterm|\bterminal\b|git ?bash|hyper|github|gitlab|bitbucket|stack ?overflow|developer\.mozilla|\bmdn\b|devdocs|readme|postman|insomnia|\bdocker\b|kubernetes|\bk8s\b|dbeaver|pgadmin|\bjira\b|confluence|swagger|\bnpm\b|pypi|crates\.io|figma|vercel|netlify|cloudflare|azure|\baws\b|supabase|firebase|mongodb|grafana|kibana|jenkins|circleci|sentry|notion/i },
  // non-video leisure / distraction (social, music)
  { mode: "leisure", re: /reddit|twitter|\bx\.com\b|facebook|instagram|9gag|discord|spotify|soundcloud|pinterest/i },
];

// Pure-entertainment streaming -> always leisure.
const ENTERTAINMENT_RE = /netflix|twitch|tiktok|hotstar|prime video|disney\+|hulu|\bhbo\b|crunchyroll/i;
// YouTube/Vimeo are split by the video title: a coding/learning video is "focus",
// anything else is leisure.
const VIDEO_RE = /youtube|vimeo/i;
const LEARNING_RE = /tutorial|course|crash course|lecture|lesson|\bhow ?to\b|explained|walkthrough|programming|coding|developer|\bdev\b|software|leetcode|algorithm|data ?structure|system design|interview|docs|documentation|conf\b|keynote|talk\b|javascript|typescript|\bpython\b|\breact\b|nextjs|\bnode\b|\brust\b|golang|\bgo\b|\bjava\b|kotlin|swift|\bc\+\+\b|\bc#\b|kubernetes|docker|\bapi\b|database|\bsql\b|linux|\bgit\b|webpack|\bvite\b|\bcss\b|\bhtml\b|machine learning|\bml\b|\bai\b|neural/i;
// Generic web research (search engines) -> treated as work.
const RESEARCH_RE = /google search|duckduckgo|\bbing\b|wikipedia|\- google\b/i;

export function classifyContext(app: string, title: string, userRules?: { pattern: string; mode: string }[]): Mode {
  const s = `${app} ${title}`.toLowerCase();
  // user-defined rules win (so anyone can map their own apps/sites)
  if (userRules) {
    for (const r of userRules) {
      if (!r.pattern) continue;
      try { if (new RegExp(r.pattern, "i").test(s)) return r.mode as Mode; } catch { /* bad regex */ }
    }
  }
  if (ENTERTAINMENT_RE.test(s)) return "leisure";
  if (VIDEO_RE.test(s)) return LEARNING_RE.test(s) ? "focus" : "leisure";  // smart split
  for (const r of RULES) if (r.re.test(s)) return r.mode;
  if (RESEARCH_RE.test(s)) return "coding";
  return "neutral";
}

/** is this a "working" mode where the cat should stay awake/quiet-ish? */
export function isWorkMode(m: Mode): boolean {
  return m === "focus" || m === "coding" || m === "ai";
}
