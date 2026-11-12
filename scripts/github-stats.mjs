// Builds the "GitHub activity" card for the profile README.
// Usage: GITHUB_TOKEN=... node scripts/github-stats.mjs
//        node scripts/github-stats.mjs --placeholder   (empty card, no API call)
// Writes assets/stats-dark.svg and assets/stats-light.svg (1200x500).
// No dependencies: Node 20+ built-in fetch only.
// If the API call fails, nothing is written and the process exits with code 1.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOGIN = process.env.GITHUB_LOGIN || 'Fahis7';
const PLACEHOLDER = process.argv.includes('--placeholder');

const W = 1200;
const H = 500;
const FONT = 'IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const THEMES = {
  dark: { bg: '#0d0e11', text: '#f2f2f0', muted: '#a3a39e', line: 'rgba(255,255,255,.09)', accent: '#e0567a' },
  light: { bg: '#ececeb', text: '#111214', muted: '#5d5d58', line: 'rgba(0,0,0,.10)', accent: '#ad314d' },
};

// LED dot glyphs, same 5x7 grid as the portfolio DotText (digits and the few marks numbers need).
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['010', '110', '010', '010', '010', '010', '111'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  ',': ['00', '00', '00', '00', '00', '01', '01', '10'],
  '-': ['000', '000', '000', '111', '000', '000', '000'],
};

// ---------- data ----------

async function gql(query, variables) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-stats-card' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GitHub API: ${json.errors.map((e) => e.message).join('; ')}`);
  return json.data;
}

async function fetchData() {
  const main = await gql(
    `query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date weekday contributionCount contributionLevel } }
          }
        }
        repositories(privacy: PUBLIC) { totalCount }
      }
    }`,
    { login: LOGIN },
  );
  if (!main.user) throw new Error(`GitHub user "${LOGIN}" not found`);

  const bytes = new Map();
  let after = null;
  for (let page = 0; page < 20; page++) {
    const d = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes { languages(first: 20, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } } }
          }
        }
      }`,
      { login: LOGIN, after },
    );
    const repos = d.user.repositories;
    for (const r of repos.nodes) {
      for (const e of r.languages.edges) bytes.set(e.node.name, (bytes.get(e.node.name) || 0) + e.size);
    }
    if (!repos.pageInfo.hasNextPage) break;
    after = repos.pageInfo.endCursor;
  }

  const cal = main.user.contributionsCollection.contributionCalendar;
  return {
    total: cal.totalContributions,
    weeks: cal.weeks.map((w) => w.contributionDays),
    publicRepos: main.user.repositories.totalCount,
    languages: [...bytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

function placeholderData() {
  const weeks = [];
  const end = new Date();
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - 364));
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0) weeks.push([]);
    weeks.at(-1).push({ date: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), contributionCount: 0, contributionLevel: 'NONE' });
  }
  return { total: 0, weeks, publicRepos: 0, languages: [], placeholder: true };
}

function summarise(data) {
  const days = data.weeks.flat();
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Current streak: counted back from today; today with no contributions yet does not break it.
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i--;
  for (; i >= 0 && days[i].contributionCount > 0; i--) current++;

  const langTotal = data.languages.reduce((s, [, b]) => s + b, 0);
  return {
    ...data,
    current,
    longest,
    last30: days.slice(-30),
    langs: data.languages.map(([name, b]) => ({ name, pct: langTotal ? (b / langTotal) * 100 : 0 })),
  };
}

// ---------- drawing ----------

const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const fmtDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

function label(x, y, text, fill, { size = 12, anchor = 'start', spacing = 1.6, weight = 400 } = {}) {
  return `<text x="${r1(x)}" y="${r1(y)}" fill="${fill}" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" text-anchor="${anchor}">${esc(String(text).toUpperCase())}</text>`;
}

// LED dot number. s scales the DotText grid (x pitch 5, y pitch 4, radius 1.55).
function dots(text, x, y, s, fill) {
  const px = 5 * s;
  const py = 4 * s;
  const rad = r1(1.55 * s);
  let cx = x;
  let out = '';
  for (const ch of String(text)) {
    const g = GLYPHS[ch];
    if (!g) { cx += 3 * px; continue; }
    g.forEach((row, ry) => [...row].forEach((bit, col) => {
      if (bit === '1') out += `<circle cx="${r1(cx + col * px + rad)}" cy="${r1(y + ry * py + rad)}" r="${rad}"/>`;
    }));
    cx += (g[0].length + 1) * px;
  }
  return `<g fill="${fill}">${out}</g>`;
}

const LEVEL_OPACITY = { FIRST_QUARTILE: 0.3, SECOND_QUARTILE: 0.52, THIRD_QUARTILE: 0.76, FOURTH_QUARTILE: 1 };

function heatmap(t, weeks, x0, y0) {
  const pitch = 12;
  const weeksShown = weeks.slice(-53);
  let out = '';
  let lastLabelCol = -10;
  weeksShown.forEach((week, col) => {
    for (const d of week) {
      const cx = r1(x0 + col * pitch + pitch / 2);
      const cy = r1(y0 + d.weekday * pitch + pitch / 2);
      const op = LEVEL_OPACITY[d.contributionLevel];
      out += op
        ? `<circle cx="${cx}" cy="${cy}" r="4.3" fill="${t.accent}" fill-opacity="${op}"/>`
        : `<circle cx="${cx}" cy="${cy}" r="1.4" fill="${t.muted}" fill-opacity=".35"/>`;
    }
    // Month label under the first week that contains the 1st of a month.
    const first = week.find((d) => d.date.endsWith('-01'));
    if (first && col - lastLabelCol >= 3) {
      out += label(x0 + col * pitch + 2, y0 + 7 * pitch + 20, MONTHS[Number(first.date.slice(5, 7)) - 1], t.muted, { size: 11, spacing: 1.2 });
      lastLabelCol = col;
    }
  });
  return out;
}

function languageBar(t, langs, x0, y0, width) {
  const h = 12;
  let out = `<defs><clipPath id="langclip"><rect x="${x0}" y="${y0}" width="${width}" height="${h}" rx="${h / 2}"/></clipPath></defs>`;
  out += `<rect x="${x0}" y="${y0}" width="${width}" height="${h}" rx="${h / 2}" fill="${t.line}"/>`;
  const ops = [1, 0.78, 0.58, 0.4, 0.25];
  let x = x0;
  out += '<g clip-path="url(#langclip)">';
  langs.forEach((l, i) => {
    const w = (l.pct / 100) * width;
    const gap = i < langs.length - 1 ? 2 : 0;
    out += `<rect x="${r1(x)}" y="${y0}" width="${r1(Math.max(0, w - gap))}" height="${h}" fill="${t.accent}" fill-opacity="${ops[i]}"/>`;
    x += w;
  });
  out += '</g>';
  langs.forEach((l, i) => {
    const lx = x0 + (i % 3) * (width / 3);
    const ly = y0 + 42 + Math.floor(i / 3) * 26;
    out += `<circle cx="${lx + 5}" cy="${ly - 4}" r="4.5" fill="${t.accent}" fill-opacity="${ops[i]}"/>`;
    out += label(lx + 18, ly, l.name, t.text, { size: 12, spacing: 1.2 });
    out += label(lx + 18 + (l.name.length * 8.4) + 10, ly, `${l.pct.toFixed(1)}%`, t.muted, { size: 12, spacing: 1.2 });
  });
  if (!langs.length) out += label(x0, y0 + 42, 'Waiting for first update', t.muted, { size: 12 });
  return out;
}

function lineGraph(t, days, x0, y0, x1, y1) {
  const max = Math.max(1, ...days.map((d) => d.contributionCount));
  const n = Math.max(1, days.length - 1);
  const px = (i) => x0 + (i / n) * (x1 - x0);
  const py = (v) => y1 - (v / max) * (y1 - y0);
  let out = '';
  for (const v of [0, max / 2, max]) {
    out += `<line x1="${x0}" x2="${x1}" y1="${r1(py(v))}" y2="${r1(py(v))}" stroke="${t.line}" stroke-width="1"/>`;
    out += label(x0 - 10, py(v) + 4, Math.round(v), t.muted, { size: 11, anchor: 'end', spacing: 0.8 });
  }
  if (days.length) {
    const pts = days.map((d, i) => `${r1(px(i))},${r1(py(d.contributionCount))}`);
    out += `<polygon points="${r1(x0)},${y1} ${pts.join(' ')} ${r1(px(days.length - 1))},${y1}" fill="${t.accent}" fill-opacity=".1"/>`;
    out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    out += `<g fill="${t.accent}">${days.map((d, i) => `<circle cx="${r1(px(i))}" cy="${r1(py(d.contributionCount))}" r="2.6"/>`).join('')}</g>`;
    const ticks = [0, Math.floor((days.length - 1) / 2), days.length - 1];
    ticks.forEach((i, k) => {
      out += label(px(i), y1 + 22, fmtDate(days[i].date), t.muted, { size: 11, spacing: 1.2, anchor: ['start', 'middle', 'end'][k] });
    });
  }
  return out;
}

function render(t, s, updated) {
  const stats = [
    [s.total.toLocaleString('en-US'), 'Contributions'],
    [String(s.current), 'Current streak · days'],
    [String(s.longest), 'Longest streak · days'],
    [String(s.publicRepos), 'Public repos'],
  ];
  const statBlocks = stats.map(([num, name], i) => {
    const x = 40 + i * 285;
    return dots(num, x, 92, 1.6, t.text) + label(x, 170, name, t.muted, { size: 12 });
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="GitHub activity: ${esc(s.total)} contributions in the last 12 months, current streak ${s.current} days, longest streak ${s.longest} days.">
<rect width="${W}" height="${H}" rx="16" fill="${t.bg}"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="15.5" fill="none" stroke="${t.line}"/>
${label(40, 46, 'GitHub activity · last 12 months', t.text, { size: 13, spacing: 2.2, weight: 500 })}
${label(W - 40, 46, updated, t.accent, { size: 13, anchor: 'end', spacing: 2.2, weight: 500 })}
<line x1="40" x2="${W - 40}" y1="66" y2="66" stroke="${t.line}"/>
${statBlocks}
<line x1="40" x2="${W - 40}" y1="198" y2="198" stroke="${t.line}"/>
${label(40, 228, 'Contributions · 53 weeks', t.muted, { size: 11 })}
${heatmap(t, s.weeks, 40, 240)}
${label(40, 378, 'Top languages · by bytes', t.muted, { size: 11 })}
${languageBar(t, s.langs, 40, 392, 636)}
<line x1="712" x2="712" y1="214" y2="462" stroke="${t.line}"/>
${label(750, 228, 'Last 30 days · contributions / day', t.muted, { size: 11 })}
${lineGraph(t, s.last30, 760, 256, W - 40, 432)}
</svg>
`;
}

// ---------- main ----------

async function main() {
  let data;
  try {
    data = PLACEHOLDER ? placeholderData() : await fetchData();
  } catch (err) {
    console.error(`Stats not updated, old SVGs kept. ${err.message}`);
    process.exit(1);
  }
  const s = summarise(data);
  const today = new Date();
  const updated = data.placeholder
    ? 'Awaiting first run'
    : `Updated ${today.getUTCDate()} ${MONTHS[today.getUTCMonth()]} ${today.getUTCFullYear()}`;

  const out = Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, render(t, s, updated)]));
  mkdirSync(join(ROOT, 'assets'), { recursive: true });
  for (const [k, svg] of Object.entries(out)) writeFileSync(join(ROOT, 'assets', `stats-${k}.svg`), svg);

  console.log(JSON.stringify({
    login: LOGIN,
    totalContributions: s.total,
    currentStreak: s.current,
    longestStreak: s.longest,
    publicRepos: s.publicRepos,
    topLanguages: s.langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`),
    last30DaysTotal: s.last30.reduce((a, d) => a + d.contributionCount, 0),
  }, null, 2));
}

main();
