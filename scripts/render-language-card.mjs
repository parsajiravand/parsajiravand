#!/usr/bin/env node
// Renders assets/languages.svg and assets/languages-dark.svg from the public
// GitHub API.
//
// Why this exists: the old README used github-readme-stats.vercel.app for its
// top-languages card, and that deployment is paused (503), so the image broke.
// lowlighter/metrics can render the same thing, but its languages plugin needs
// a personal access token — the GITHUB_TOKEN available to Actions is scoped to
// this one repository, so it reports "1 Repository / 0 Languages".
//
// The data is public, though: /users/:user/repos plus /repos/:owner/:repo/languages
// needs no auth at all. So we aggregate it here and commit the SVG. Nothing
// external has to stay up for the README to render.

const USER = process.env.GH_USER || "parsajiravand";
const TOKEN = process.env.GITHUB_TOKEN || "";
const TOP_N = 8;

const headers = {
  accept: "application/vnd.github+json",
  "user-agent": `${USER}-profile-readme`,
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

// Linguist colors for the languages that actually show up here, with a
// deterministic fallback for anything new.
const COLORS = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Vue: "#41b883", HTML: "#e34c26",
  CSS: "#563d7c", SCSS: "#c6538c", SASS: "#a53b70", Less: "#1d365d",
  Python: "#3572A5", Shell: "#89e051", Dockerfile: "#384d54", Java: "#b07219",
  PHP: "#4F5D95", Ruby: "#701516", Go: "#00ADD8", Rust: "#dea584",
  Svelte: "#ff3e00", Astro: "#ff5a03", MDX: "#fcb32c", Handlebars: "#f7931e",
  EJS: "#a91e50", Pug: "#a86454", C: "#555555", "C++": "#f34b7d",
  "C#": "#178600", Kotlin: "#A97BFF", Swift: "#F05138", Dart: "#00B4AB",
  Makefile: "#427819", Batchfile: "#C1F12E", Nunjucks: "#3d8137",
};
const FALLBACK = ["#8b949e", "#6e7681", "#484f58", "#57606a"];
const colorFor = (name, i) => COLORS[name] || FALLBACK[i % FALLBACK.length];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, attempt = 0) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.ok) return res.json();

  // A spent rate limit will not recover in the life of this run, so fail fast
  // and let the caller abort rather than burning retries. Secondary limits and
  // 5xx blips are worth a short backoff.
  const exhausted = res.headers.get("x-ratelimit-remaining") === "0";
  const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && !exhausted);
  if (retryable && attempt < 3) {
    await sleep(1000 * 2 ** attempt);
    return api(path, attempt + 1);
  }
  throw new Error(`${res.status} ${res.statusText} on ${path}${exhausted ? " (rate limit exhausted)" : ""}`);
}

async function listRepos() {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/users/${USER}/repos?per_page=100&page=${page}&type=owner`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  // Forks are other people's code; counting them would misreport the profile.
  return repos.filter((r) => !r.fork);
}

async function collectBytes(repos) {
  const totals = new Map();
  const failed = [];

  for (const repo of repos) {
    try {
      const langs = await api(`/repos/${repo.full_name}/languages`);
      for (const [name, bytes] of Object.entries(langs)) {
        totals.set(name, (totals.get(name) || 0) + bytes);
      }
    } catch (err) {
      failed.push(`${repo.name} (${err.message})`);
    }
  }

  // Every missing repo drops its whole byte count, so partial data does not
  // degrade — it silently reweights the chart toward whichever repos happened
  // to succeed. A rate-limited run once turned TypeScript 35% / JavaScript 20%
  // into JavaScript 45% / TypeScript 39%. Refuse to publish that: exiting
  // non-zero leaves the last good card committed in the repo.
  const tolerated = Math.max(1, Math.floor(repos.length * 0.05));
  if (failed.length > tolerated) {
    console.error(`\n${failed.length}/${repos.length} language lookups failed (tolerating ${tolerated}):`);
    for (const f of failed.slice(0, 5)) console.error(`  - ${f}`);
    throw new Error("too many failed lookups — refusing to write a skewed card");
  }
  if (failed.length) console.warn(`  ${failed.length} repo(s) skipped: ${failed.join(", ")}`);

  return totals;
}

function buildRows(totals) {
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const grand = sorted.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (!grand) throw new Error("no language bytes found — refusing to write an empty card");

  // A language that rounds to 0.0% is noise in the legend — roll anything below
  // the display threshold into "Other" instead of printing a 0.0% row.
  const MIN_PCT = 0.1;
  const pctOf = (bytes) => (bytes / grand) * 100;

  const rows = [];
  let rest = 0;
  for (const [name, bytes] of sorted) {
    const pct = pctOf(bytes);
    if (rows.length < TOP_N && pct >= MIN_PCT) {
      rows.push({ name, pct, color: colorFor(name, rows.length) });
    } else {
      rest += bytes;
    }
  }
  if (pctOf(rest) >= MIN_PCT) {
    rows.push({ name: "Other", pct: pctOf(rest), color: "#6e7681" });
  }
  return rows;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderSvg(rows, repoCount, theme) {
  const t = theme === "dark"
    ? { bg: "#0d1117", border: "#30363d", title: "#e6edf3", text: "#8b949e", track: "#21262d" }
    : { bg: "#ffffff", border: "#d0d7de", title: "#1f2328", text: "#59636e", track: "#eaeef2" };

  const W = 480, PAD = 24, BAR_Y = 62, BAR_H = 10, BAR_W = W - PAD * 2;
  const COLS = 2, COL_W = BAR_W / COLS, ROW_H = 22, LEGEND_Y = BAR_Y + BAR_H + 26;
  const legendRows = Math.ceil(rows.length / COLS);
  const H = LEGEND_Y + legendRows * ROW_H + 14;

  // Stacked bar. Percentages are floats, so track the running offset in user
  // units rather than rounding each segment independently.
  let x = PAD;
  const segments = rows.map((r) => {
    const w = (r.pct / 100) * BAR_W;
    const seg = `<rect x="${x.toFixed(2)}" y="${BAR_Y}" width="${Math.max(w, 0.6).toFixed(2)}" height="${BAR_H}" fill="${r.color}" />`;
    x += w;
    return seg;
  }).join("\n    ");

  const legend = rows.map((r, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const lx = PAD + col * COL_W, ly = LEGEND_Y + row * ROW_H;
    return `<g transform="translate(${lx.toFixed(2)}, ${ly})">
      <circle cx="5" cy="5" r="5" fill="${r.color}" />
      <text x="18" y="9" fill="${t.title}" font-size="12" font-weight="600">${esc(r.name)}</text>
      <text x="${(COL_W - 34).toFixed(2)}" y="9" fill="${t.text}" font-size="12" text-anchor="end">${r.pct.toFixed(1)}%</text>
    </g>`;
  }).join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Most used languages across ${repoCount} public repositories">
  <defs>
    <clipPath id="bar-clip"><rect x="${PAD}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="5" /></clipPath>
  </defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="${t.bg}" stroke="${t.border}" />
  <g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif">
    <text x="${PAD}" y="32" fill="${t.title}" font-size="15" font-weight="600">Most used languages</text>
    <text x="${PAD}" y="50" fill="${t.text}" font-size="11.5">by bytes of code across ${repoCount} public repositories</text>
    <rect x="${PAD}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="5" fill="${t.track}" />
    <g clip-path="url(#bar-clip)">
    ${segments}
    </g>
    ${legend}
  </g>
</svg>
`;
}

const { writeFileSync, mkdirSync } = await import("node:fs");

console.log(`Fetching public repositories for ${USER}${TOKEN ? " (authenticated)" : " (unauthenticated)"}...`);
const repos = await listRepos();
console.log(`  ${repos.length} non-fork public repositories`);

const totals = await collectBytes(repos);
const rows = buildRows(totals);
console.log("Language breakdown:");
for (const r of rows) console.log(`  ${r.name.padEnd(14)} ${r.pct.toFixed(1)}%`);

mkdirSync("assets", { recursive: true });
writeFileSync("assets/languages.svg", renderSvg(rows, repos.length, "light"));
writeFileSync("assets/languages-dark.svg", renderSvg(rows, repos.length, "dark"));
console.log("Wrote assets/languages.svg and assets/languages-dark.svg");
