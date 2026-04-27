// DTCG Token Visualizer
// Fetches tokens.dtcg.json directly from GitHub on every load, so the
// site always reflects what is committed on the main branch.

const REPO_OWNER = "Buydens";
const REPO_NAME = "tokens_DTCG";
const TOKEN_FILE = "tokens.dtcg.json";
const BRANCH = "main";

const RAW_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${TOKEN_FILE}`;
const COMMITS_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits?path=${TOKEN_FILE}&per_page=1`;

const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");
const navEl = document.getElementById("nav");
const lastCommitEl = document.getElementById("lastCommit");
const refreshBtn = document.getElementById("refreshBtn");

let tokenData = null; // raw parsed JSON

// ---------- helpers ----------

function setStatus(msg, isError = false) {
  if (!msg) {
    statusEl.classList.remove("visible", "error");
    statusEl.textContent = "";
    return;
  }
  statusEl.textContent = msg;
  statusEl.classList.add("visible");
  statusEl.classList.toggle("error", isError);
}

// True if a node is a DTCG token (has $value)
function isToken(node) {
  return node && typeof node === "object" && Object.prototype.hasOwnProperty.call(node, "$value");
}

// Resolve an alias like "{Primitives.Colors.Grey.color-grey-700}" to a final value.
// Returns { value, type, chain: [path, ...] } or null if unresolved.
function resolveAlias(value, type) {
  const chain = [];
  let current = value;
  let currentType = type;
  let safety = 0;
  while (typeof current === "string" && current.startsWith("{") && current.endsWith("}")) {
    if (safety++ > 20) break;
    const path = current.slice(1, -1);
    chain.push(path);
    const target = getByPath(tokenData, path);
    if (!isToken(target)) {
      return { value: undefined, type: currentType, chain, unresolved: true };
    }
    current = target.$value;
    currentType = target.$type || currentType;
  }
  return { value: current, type: currentType, chain };
}

function getByPath(root, dotPath) {
  const parts = dotPath.split(".");
  let cur = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function isAlias(v) {
  return typeof v === "string" && v.startsWith("{") && v.endsWith("}");
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------- fetching ----------

async function loadTokens() {
  setStatus("Fetching tokens…");
  try {
    const res = await fetch(`${RAW_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tokenData = await res.json();
    setStatus(null);
    render();
  } catch (err) {
    setStatus(`Failed to load tokens: ${err.message}`, true);
  }
  loadLastCommit();
}

async function loadLastCommit() {
  try {
    const res = await fetch(COMMITS_API, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const commits = await res.json();
    if (!commits.length) {
      lastCommitEl.textContent = "No commit info";
      return;
    }
    const c = commits[0];
    const when = new Date(c.commit.author.date);
    const rel = relativeTime(when);
    const sha = c.sha.slice(0, 7);
    lastCommitEl.innerHTML = `Updated ${rel} · <a href="${c.html_url}" target="_blank" rel="noopener">${sha}</a>`;
  } catch (err) {
    lastCommitEl.textContent = "Update info unavailable";
  }
}

function relativeTime(date) {
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days} d ago`;
  return date.toISOString().slice(0, 10);
}

// ---------- rendering ----------

function render() {
  contentEl.innerHTML = "";
  navEl.innerHTML = "";

  // Build a list of top-level "sections" to render.
  // Each top-level key (Primitives, Semantic) gets its child groups as sections.
  const sections = []; // { id, title, breadcrumb, node }

  for (const [topKey, topVal] of Object.entries(tokenData)) {
    if (!topVal || typeof topVal !== "object") continue;
    const navGroup = document.createElement("ul");
    const label = document.createElement("li");
    label.className = "group-label";
    label.textContent = topKey;
    label.dataset.role = "group-label";
    navGroup.appendChild(label);

    for (const [groupKey, groupVal] of Object.entries(topVal)) {
      if (!groupVal || typeof groupVal !== "object" || isToken(groupVal)) continue;
      const id = slug(`${topKey}-${groupKey}`);
      sections.push({
        id,
        title: groupKey,
        breadcrumb: `${topKey} › ${groupKey}`,
        node: groupVal,
      });
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${id}`;
      a.textContent = groupKey;
      li.appendChild(a);
      navGroup.appendChild(li);
    }
    navEl.appendChild(navGroup);
  }

  for (const s of sections) {
    contentEl.appendChild(renderSection(s));
  }

  setupScrollSpy(sections.map(s => s.id));
}

function renderSection({ id, title, breadcrumb, node }) {
  const sec = document.createElement("section");
  sec.className = "token-section";
  sec.id = id;

  const h2 = document.createElement("h2");
  h2.textContent = title;
  sec.appendChild(h2);

  const crumb = document.createElement("div");
  crumb.className = "breadcrumb";
  crumb.textContent = breadcrumb;
  sec.appendChild(crumb);

  // Walk the node: collect tokens grouped by their parent subgroup.
  // Direct children that are tokens go into a default subgroup ("").
  const subgroups = collectSubgroups(node);

  for (const [subName, tokens] of subgroups) {
    if (!tokens.length) continue;
    const wrap = document.createElement("div");
    wrap.className = "subgroup";
    if (subName) {
      const h3 = document.createElement("h3");
      h3.textContent = subName;
      wrap.appendChild(h3);
    }
    wrap.appendChild(renderTokens(tokens, title));
    sec.appendChild(wrap);
  }

  return sec;
}

// Returns Array<[subgroupName, Array<{ name, token, path }>]>
// Tokens at any depth are flattened, grouped by their immediate parent path
// relative to the section root. Direct token children are grouped under "".
function collectSubgroups(root) {
  const map = new Map();
  function walk(node, parentName) {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (isToken(v)) {
        if (!map.has(parentName)) map.set(parentName, []);
        map.get(parentName).push({ name: k, token: v });
      } else if (v && typeof v === "object") {
        const childName = parentName ? `${parentName} / ${k}` : k;
        walk(v, childName);
      }
    }
  }
  walk(root, "");
  return Array.from(map.entries());
}

function renderTokens(tokens, sectionTitle) {
  // Decide rendering style by the dominant $type and section name
  const types = new Set(tokens.map(t => t.token.$type).filter(Boolean));
  const allColors = types.size === 1 && types.has("color");
  const sectionLow = sectionTitle.toLowerCase();

  const grid = document.createElement("div");
  grid.className = "grid";

  if (allColors) {
    grid.classList.add("colors");
    for (const t of tokens) grid.appendChild(renderColor(t));
    return grid;
  }

  // Typography: font sizes (font-size-*) and font weights (font-weight-*)
  if (tokens.every(t => /^font-size/i.test(t.name))) {
    grid.classList.add("fontsizes");
    for (const t of tokens) grid.appendChild(renderFontSize(t));
    return grid;
  }
  if (tokens.every(t => /^font-weight/i.test(t.name))) {
    grid.classList.add("fontweights");
    for (const t of tokens) grid.appendChild(renderFontWeight(t));
    return grid;
  }

  // Layouts (breakpoints with width)
  if (sectionLow === "layouts" && tokens.every(t => t.token.$type === "number")) {
    grid.classList.add("layouts");
    const max = Math.max(...tokens.map(t => Number(resolveAlias(t.token.$value, t.token.$type).value) || 0));
    for (const t of tokens) grid.appendChild(renderBreakpoint(t, max));
    return grid;
  }

  // Numeric (sizes, etc)
  if (tokens.every(t => t.token.$type === "number")) {
    grid.classList.add("numbers");
    const max = Math.max(...tokens.map(t => Number(resolveAlias(t.token.$value, t.token.$type).value) || 0));
    for (const t of tokens) grid.appendChild(renderNumber(t, max));
    return grid;
  }

  // Fallback: generic cards
  grid.classList.add("generic");
  for (const t of tokens) grid.appendChild(renderGeneric(t));
  return grid;
}

function renderColor({ name, token }) {
  const card = document.createElement("div");
  card.className = "color-card";
  const resolved = resolveAlias(token.$value, token.$type);
  const colorVal = resolved.value || "#fff";

  const swatch = document.createElement("div");
  swatch.className = "color-swatch";
  swatch.style.setProperty("--swatch-color", colorVal);
  card.appendChild(swatch);

  const meta = document.createElement("div");
  meta.className = "color-meta";

  const nm = document.createElement("div");
  nm.className = "name";
  nm.textContent = name;
  meta.appendChild(nm);

  const val = document.createElement("div");
  val.className = "value";
  val.textContent = resolved.unresolved ? "unresolved alias" : colorVal;
  meta.appendChild(val);

  if (resolved.chain.length) {
    const a = document.createElement("div");
    a.className = "alias";
    a.textContent = "→ " + resolved.chain[resolved.chain.length - 1];
    a.title = resolved.chain.join("  →  ");
    meta.appendChild(a);
  }

  card.appendChild(meta);
  return card;
}

function renderNumber({ name, token }, max) {
  const card = document.createElement("div");
  card.className = "num-card";

  const nm = document.createElement("div");
  nm.className = "name";
  nm.textContent = name;
  card.appendChild(nm);

  const resolved = resolveAlias(token.$value, token.$type);
  const num = Number(resolved.value);
  const pct = max > 0 && Number.isFinite(num) ? Math.max(2, (num / max) * 100) : 0;

  const barWrap = document.createElement("div");
  barWrap.className = "bar-wrap";
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.style.width = pct + "%";
  barWrap.appendChild(bar);
  card.appendChild(barWrap);

  const val = document.createElement("div");
  val.className = "value";
  val.textContent = Number.isFinite(num) ? `${num}` : String(token.$value);
  card.appendChild(val);

  if (resolved.chain.length) {
    const a = document.createElement("div");
    a.className = "alias";
    a.textContent = "→ " + resolved.chain[resolved.chain.length - 1];
    card.appendChild(a);
  }

  return card;
}

function renderFontSize({ name, token }) {
  const row = document.createElement("div");
  row.className = "fs-row";
  const resolved = resolveAlias(token.$value, token.$type);
  const px = Number(resolved.value);

  const label = document.createElement("div");
  label.className = "fs-label";
  label.textContent = `${name} · ${Number.isFinite(px) ? px + "px" : token.$value}`;
  row.appendChild(label);

  const preview = document.createElement("div");
  preview.className = "fs-preview";
  preview.textContent = "The quick brown fox jumps over the lazy dog";
  if (Number.isFinite(px)) preview.style.fontSize = px + "px";
  row.appendChild(preview);

  return row;
}

function renderFontWeight({ name, token }) {
  const card = document.createElement("div");
  card.className = "fw-card";
  const resolved = resolveAlias(token.$value, token.$type);
  const w = Number(resolved.value);

  const preview = document.createElement("div");
  preview.className = "preview";
  preview.textContent = "Aa";
  if (Number.isFinite(w)) preview.style.fontWeight = w;
  card.appendChild(preview);

  const nm = document.createElement("div");
  nm.className = "name";
  nm.textContent = `${name} · ${Number.isFinite(w) ? w : token.$value}`;
  card.appendChild(nm);

  return card;
}

function renderBreakpoint({ name, token }, max) {
  const row = document.createElement("div");
  row.className = "bp-row";
  const resolved = resolveAlias(token.$value, token.$type);
  const w = Number(resolved.value);

  const label = document.createElement("div");
  label.className = "bp-label";
  label.textContent = name;
  row.appendChild(label);

  const bar = document.createElement("div");
  bar.className = "bp-bar";
  const fill = document.createElement("div");
  fill.className = "bp-fill";
  fill.style.width = max > 0 ? Math.max(2, (w / max) * 100) + "%" : "0%";
  bar.appendChild(fill);
  row.appendChild(bar);

  const val = document.createElement("div");
  val.className = "bp-value";
  val.textContent = Number.isFinite(w) ? `${w}px` : String(token.$value);
  row.appendChild(val);

  return row;
}

function renderGeneric({ name, token }) {
  const card = document.createElement("div");
  card.className = "generic-card";
  const resolved = resolveAlias(token.$value, token.$type);

  const nm = document.createElement("div");
  nm.className = "name";
  nm.textContent = name;
  card.appendChild(nm);

  const val = document.createElement("div");
  val.className = "value";
  val.textContent = `[${resolved.type || "?"}] ${resolved.value ?? "(unresolved)"}`;
  card.appendChild(val);

  if (resolved.chain.length) {
    const a = document.createElement("div");
    a.className = "alias";
    a.textContent = "→ " + resolved.chain[resolved.chain.length - 1];
    card.appendChild(a);
  }

  return card;
}

// ---------- nav scroll spy ----------

function setupScrollSpy(ids) {
  const links = Array.from(navEl.querySelectorAll("a"));
  const map = new Map(links.map(a => [a.getAttribute("href").slice(1), a]));

  const observer = new IntersectionObserver(
    entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          links.forEach(l => l.classList.remove("active"));
          const a = map.get(e.target.id);
          if (a) a.classList.add("active");
        }
      }
    },
    { rootMargin: "-20% 0px -70% 0px", threshold: 0 }
  );

  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  }
}

// ---------- init ----------

refreshBtn.addEventListener("click", loadTokens);
loadTokens();
