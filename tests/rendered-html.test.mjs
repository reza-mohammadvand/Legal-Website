import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

function arrayAfter(sourceText, marker) {
  const markerIndex = sourceText.indexOf(marker);
  assert.ok(markerIndex >= 0, `Missing ${marker}`);
  const start = sourceText.indexOf("[", markerIndex + marker.length);
  assert.ok(start >= 0, `Missing array after ${marker}`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (depth === 0) return sourceText.slice(start, index + 1);
  }
  assert.fail(`Unclosed array after ${marker}`);
}

function menuIds(menuSource) {
  return [...menuSource.matchAll(/\bid\s*:\s*["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}

function assertIncludesEvery(actual, expected, label) {
  for (const item of expected) {
    assert.ok(actual.includes(item), `${label} is missing ${item}`);
  }
}

test("server-renders the Persian Dadrah application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html\s+lang=["']fa["']\s+dir=["']rtl["']/i);
  assert.match(html, /<title>[^<]*دادراه[^<]*<\/title>/i);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/i);
});

test("uses the local Sahel font and the requested design colors", async () => {
  const [layout, css] = await Promise.all([
    source("app/layout.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(layout, /<html\s+lang=["']fa["']\s+dir=["']rtl["']/i);
  assert.ok((css.match(/@font-face/gi) ?? []).length >= 3);
  assert.match(css, /font-family\s*:\s*Sahel\b/i);
  assert.match(css, /Sahel\.woff2/i);
  assert.match(css, /Sahel-SemiBold\.woff2/i);
  assert.match(css, /Sahel-Bold\.woff2/i);
  assert.match(css, /--primary\s*:\s*#1a237e\b/i);
  assert.match(css, /--gold\s*:\s*#efbf04\b/i);
  assert.match(css, /letter-spacing\s*:\s*0\b/i);

  await Promise.all(
    ["Sahel.woff2", "Sahel-SemiBold.woff2", "Sahel-Bold.woff2"].map(
      (font) => access(new URL(`public/fonts/${font}`, root)),
    ),
  );
});

test("keeps public pages and deep-link routing wired to DadrahApp", async () => {
  const [app, catchAll] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("app/[...path]/page.tsx"),
  ]);

  assert.match(catchAll, /import\s+DadrahApp\b/);
  assert.match(catchAll, /<DadrahApp\s*\/>/);
  assert.match(app, /history\.pushState/);
  assert.match(app, /["']popstate["']/);

  for (const component of ["LawyersPage", "BlogPage", "ArticlePage", "Dashboard"]) {
    assert.match(app, new RegExp(`\\b${component}\\b`));
  }
  for (const path of ["/lawyers/", "/blog/", "/dashboard"]) {
    assert.ok(app.includes(path), `Missing route mapping for ${path}`);
  }
});

test("defines distinct, feature-complete menus for every dashboard role", async () => {
  const app = await source("app/dadrah-app.tsx");
  const menuConfigStart = app.indexOf("const menus");
  assert.ok(menuConfigStart >= 0, "Missing role-aware dashboard menu config");
  const menuConfig = app.slice(menuConfigStart);

  const client = menuIds(arrayAfter(menuConfig, "client:"));
  const lawyer = menuIds(arrayAfter(menuConfig, "lawyer:"));
  const admin = menuIds(arrayAfter(menuConfig, "admin:"));

  assert.ok(client.length >= 9, "Client dashboard needs its full navigation");
  assert.ok(lawyer.length >= 9, "Lawyer dashboard needs its full navigation");
  assert.ok(admin.length >= 12, "Admin dashboard needs expanded management navigation");
  assertIncludesEvery(
    client,
    ["overview", "consultations", "messages", "documents", "payments", "questions", "saved", "support", "profile"],
    "Client menu",
  );
  assertIncludesEvery(
    lawyer,
    ["overview", "requests", "calendar", "cases", "messages", "questions", "finance", "reviews", "verification"],
    "Lawyer menu",
  );
  assertIncludesEvery(
    admin,
    ["overview", "lawyers", "users", "questions", "consultations", "payments", "content", "services", "reviews", "support", "reports", "admins", "settings"],
    "Admin menu",
  );
  assert.notDeepEqual(client, lawyer);
  assert.notDeepEqual(lawyer, admin);
  assert.match(app, /aria-current\s*=\s*\{[^}]*["']page["']/);
});

test("declares the local API and the core relational schema", async () => {
  const [api, database] = await Promise.all([
    source("server/local-api.mjs"),
    source("server/db.mjs"),
  ]);

  const endpoints = [
    "/api/health",
    "/api/bootstrap",
    "/api/auth/login",
    "/api/auth/register",
    "/api/me",
    "/api/questions",
    "/api/consultations",
    "/api/answers",
    "/api/reviews",
    "/api/bookmarks",
    "/api/messages",
    "/api/dashboard",
    "/api/admin/action",
    "/api/articles",
  ];
  assertIncludesEvery(api, endpoints, "Local API");

  const tables = [
    "users",
    "lawyers",
    "questions",
    "question_assignments",
    "answers",
    "consultations",
    "orders",
    "reviews",
    "bookmarks",
    "articles",
    "services",
    "faqs",
    "appointment_slots",
    "documents",
    "conversations",
    "chat_messages",
    "admin_permissions",
    "settings",
    "messages",
    "sessions",
  ];
  for (const table of tables) {
    assert.match(
      database,
      new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, "i"),
      `Missing ${table} table`,
    );
  }
  assert.match(database, /PRAGMA\s+foreign_keys\s*=\s*ON/i);
});

test("enforces question assignment, role guards, and server-side checkout", async () => {
  const [api, database] = await Promise.all([
    source("server/local-api.mjs"),
    source("server/db.mjs"),
  ]);

  assert.match(database, /scryptSync\s*\(/);
  assert.match(database, /timingSafeEqual\s*\(/);
  assert.match(database, /randomBytes\s*\(/);
  assert.match(database, /authorization\?\.[\s\S]*Bearer/i);
  assert.match(database, /(?:datetime\s*\(\s*s\.expires_at\s*\)|s\.expires_at)\s*>\s*datetime\s*\(\s*["']now["']\s*\)/i);

  assert.match(api, /pending_assignment/);
  assert.match(api, /INSERT\s+INTO\s+question_assignments/i);
  assert.match(api, /assign-question/);
  assert.match(api, /question_assignments[\s\S]{0,500}(assigned|answered)/i);
  assert.match(api, /user\?\.role\s*!==\s*["']lawyer["']/);
  assert.match(api, /user\?\.role\s*!==\s*["']admin["']/);
  assert.match(api, /PAYLOAD_TOO_LARGE/);

  const consultationStart = api.indexOf('/api/consultations');
  const consultationEnd = api.indexOf('/api/answers', consultationStart);
  assert.ok(consultationStart >= 0 && consultationEnd > consultationStart);
  const checkout = api.slice(consultationStart, consultationEnd);
  assert.doesNotMatch(checkout, /\bb\.amount\b/);
  assert.match(checkout, /lawyer\s*\[\s*`\$\{type\}_price`\s*\]/);
  assert.match(checkout, /default_\$\{type\}_price/);
  assert.match(checkout, /urgent_surcharge_percent/);
  assert.match(checkout, /Math\.round\(baseAmount\s*\*\s*urgentSurchargeRate\s*\/\s*100\)/);
  assert.match(checkout, /const\s+amount\s*=\s*baseAmount\s*\+\s*urgentSurchargeAmount/);
  assert.match(checkout, /BEGIN\s+IMMEDIATE/);
  assert.match(checkout, /ROLLBACK/);
  assert.match(checkout, /simulated_paid/);
});
