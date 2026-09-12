import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  const end = endMarker ? text.indexOf(endMarker, start + startMarker.length) : -1;
  return text.slice(start, end > start ? end : undefined);
}

function assertIncludesEvery(text, values, label) {
  for (const value of values) {
    assert.ok(text.includes(value), `${label} is missing ${value}`);
  }
}

function declarationsFor(css, selectorFragment) {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.includes(selectorFragment))
    .map(([, , declarations]) => declarations)
    .join(";");
}

function hasDarkRule(css, selectorFragment) {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .some(([, selectors]) => /data-theme\s*=\s*["']?dark/i.test(selectors)
      && selectors.includes(selectorFragment));
}

test("uses real default avatar assets and never renders initials as an avatar", async () => {
  const [app, data, database] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("app/dadrah-data.ts"),
    source("server/db.mjs"),
  ]);

  const avatarPaths = [
    "public/avatars/default-client.png",
    "public/avatars/default-lawyer.png",
    "public/avatars/default-admin.png",
  ];
  for (const path of avatarPaths) {
    await access(new URL(path, root));
    assert.ok((await stat(new URL(path, root))).size > 1_000, `${path} must be a real image asset`);
  }

  assert.match(app, /\/avatars\/default-\$\{[^}]*role[^}]*\}\.png/,
    "Avatar rendering must choose a role-specific default image");
  assert.match(database, /avatar_url\s*=\s*["']\/avatars\/default-["']\s*\|\|\s*role\s*\|\|\s*["']\.png["']/i,
    "Seeded accounts must receive role-specific default image paths");
  assert.match(app, /function\s+(?:\w*Avatar\w*)\s*\([^)]*\)[\s\S]{0,800}<img\b/i,
    "The UI should centralize avatar rendering around an image component");
  assert.doesNotMatch(app, /<(?:div|span)[^>]*className=["'][^"']*(?:avatar|portrait)[^"']*["'][^>]*>\s*\{[^}\n]*\.initials[^}\n]*\}/,
    "Initials must not be rendered between avatar element tags");
  assert.doesNotMatch(app, /<(?:div|span)[^>]*className=["'][^"']*(?:avatar|portrait)[^"']*["'][^>]*>\s*\{[^}\n]*\.slice\(\s*0\s*,\s*1\s*\)[^}\n]*\}/,
    "The first letter of a name must not be used as an avatar");
});

test("provides persistent dark mode and an accessible signed-in account menu", async () => {
  const [app, css] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(app, /localStorage\.(?:getItem|setItem)\(\s*["'](?:theme|dadrah-theme)["']/i);
  assert.match(app, /(?:dataset\.theme|setAttribute\(\s*["']data-theme["'])/i);
  assert.match(css, /(?:\[data-theme=["']?dark["']?\]|\.dark(?:\s|\{|:root))/i);
  assert.match(app, /(?:theme-toggle|aria-label=["'][^"']*(?:دارک|روشن|پوسته|تم)[^"']*["'])/i);

  assert.match(app, /aria-haspopup\s*=\s*["']menu["']/i);
  assert.match(app, /role\s*=\s*["']menu["']/i);
  const accountMenu = section(app, "aria-haspopup=", "function HomePage");
  assert.match(accountMenu, /dashboard/i);
  assert.match(accountMenu, /logout/i);
});

test("keeps stats, trust content, footer, and legal pages fully setting-driven", async () => {
  const [app, data, api, database] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("app/dadrah-data.ts"),
    source("server/local-api.mjs"),
    source("server/db.mjs"),
  ]);
  const sources = `${data}\n${api}\n${database}`;

  assertIncludesEvery(sources, [
    "site_views",
    "stats_enabled",
    "stats_title",
    "trust_enabled",
    "trust_items",
    "footer_config",
    "terms_content",
    "privacy_content",
  ], "Public content settings");
  assert.match(sources, /stat_labels|stats_views_label/,
    "Site statistic labels must be configurable as a map or individual settings");
  assert.match(api, /stats\s*:\s*\{[\s\S]{0,500}\bviews\b[\s\S]{0,500}\bconsultations\b[\s\S]{0,500}\breviews\b[\s\S]{0,500}\brating\b[\s\S]{0,500}\blawyers\b/i);
  assertIncludesEvery(app, ["footerConfig", "trustItems", "termsContent", "privacyContent"], "Setting-driven public UI");
  assert.match(app, /(?:PublicStats|SiteStats|StatsSection|stats-section|site-stats)/i);
  const settingsPanel = section(app, "function SiteContentSettings", "function SettingsPanel");
  assertIncludesEvery(settingsPanel, [
    "footer_config",
    "terms_content",
    "privacy_content",
    "trust_items",
  ], "Admin public-content editor");
  const footer = section(app, "function SiteFooter", undefined);
  assert.match(footer, /footerConfig/,
    "The public footer must render its admin-controlled configuration");
});

test("keeps login role-aware, requires mobile registration, and exposes the password recovery stub", async () => {
  const [app, api, migration] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
    source("drizzle/0000_dadrah_core.sql"),
  ]);

  const loginApi = section(api, '/api/auth/login', '/api/auth/register');
  assert.match(loginApi, /expectedRole/);
  assert.match(loginApi, /user\.role\s*!==\s*expectedRole/);
  assert.match(app, /JSON\.stringify\(\{[^}]*username[^}]*password[^}]*expectedRole\s*:\s*role/s);
  assert.ok(api.includes("/api/auth/forgot-password"));
  assert.ok(app.includes("/auth/forgot-password"));
  assert.match(app, /name=["']phone["'][^>]*\brequired\b/i);
  assert.match(migration, /\bphone\s+TEXT\s+NOT\s+NULL\b/i);
});

test("enforces the configurable free-question and top-lawyer assignment limits", async () => {
  const [api, database] = await Promise.all([
    source("server/local-api.mjs"),
    source("server/db.mjs"),
  ]);
  const createQuestion = section(api, 'url.pathname === "/api/questions"', 'url.pathname === "/api/consultations"');

  assert.match(database, /["']free_question_limit["']\s*,\s*["']3["']/);
  assert.match(database, /["']max_question_lawyers["']\s*,\s*["']3["']/);
  assert.match(createQuestion, /COUNT\(\*\)[\s\S]{0,180}client_id\s*=\s*\?[^\n]{0,220}settingNumber\(["']free_question_limit["']\s*,\s*3\)/i);
  assert.match(createQuestion, /ORDER BY\s+l\.featured\s+DESC\s*,\s*l\.rating\s+DESC/i);
  assert.match(createQuestion, /LIMIT\s+\?[^\n]{0,160}answerLimit\(\)/i);
  assert.match(createQuestion, /INSERT\s+INTO\s+question_assignments/i);

  const assignmentApi = section(api, 'action === "assign-question"', 'action === "schedule-phone"');
  assert.match(assignmentApi, /requestedIds\.length\s*>\s*answerLimit\(\)/);
});

test("exposes answers incrementally while preserving the global answer limit", async () => {
  const api = await source("server/local-api.mjs");
  const answerApi = section(api, 'url.pathname === "/api/answers"', 'url.pathname === "/api/reviews"');
  const dashboardApi = section(api, 'url.pathname === "/api/dashboard"', 'url.pathname === "/api/lawyer/action"');
  const clientDashboard = section(dashboardApi, 'user.role === "client"', 'user.role === "lawyer"');

  assert.match(answerApi, /EXISTS\s*\([\s\S]{0,350}question_assignments[\s\S]{0,180}qa\.status\s*=\s*["']assigned["']/i);
  assert.match(answerApi, /SELECT\s+1\s+FROM\s+answers\s+WHERE\s+question_id=\?\s+AND\s+lawyer_id=\?/i,
    "A lawyer should still be prevented from answering the same question twice");
  assert.match(answerApi, /COUNT\(\*\)[\s\S]{0,160}FROM\s+answers[\s\S]{0,160}>?=\s*answerLimit\(\)/i,
    "The configured maximum answer count must still be enforced");
  assert.match(clientDashboard, /questionRows\.map\([\s\S]{0,500}const\s+answers\s*=\s*answerStatement\.all\(question\.id\)[\s\S]{0,180}return\s*\{[^}]*\banswers\b/,
    "Every answer received so far must be returned even while the question remains assigned");
  assert.doesNotMatch(clientDashboard, /question\.status\s*===?\s*["']answered["'][\s\S]{0,180}answerStatement/,
    "Incremental answers must not be hidden until the whole question is marked answered");
});

test("coordinates phone consultations privately through admin-owned phone slots", async () => {
  const api = await source("server/local-api.mjs");
  const bootstrap = section(api, "const publicBootstrap", "const server = createServer");
  const consultations = section(api, 'url.pathname === "/api/consultations"', 'url.pathname === "/api/answers"');
  const schedulePhone = section(api, 'action === "schedule-phone"', 'action === "moderate-answer"');

  assert.match(bootstrap, /appointment_slots[\s\S]{0,260}consultation_type\s*=\s*["']in_person["']/i);
  assert.doesNotMatch(bootstrap, /available_slots[\s\S]{0,180}consultation_type\s*=\s*["']phone["']/i);
  assert.match(consultations, /type\s*===\s*["']phone["']\s*\?\s*["']pending_coordination["']/);
  assert.match(consultations, /let\s+scheduledAt\s*=\s*selectedSlot\s*\?[^;]*:\s*null/);
  assert.match(schedulePhone, /consultations\.manage/);
  assert.match(schedulePhone, /consultation_type\s*=\s*["']phone["']/i);
  assert.match(schedulePhone, /UPDATE\s+consultations\s+SET\s+lawyer_id=\?,slot_id=\?,scheduled_at=\?,status=["']confirmed["']/i);
});

test("counts consecutive paid-text messages as turns instead of raw messages", async () => {
  const [api, schema, migration, database] = await Promise.all([
    source("server/local-api.mjs"),
    source("db/schema.ts"),
    source("drizzle/0000_dadrah_core.sql"),
    source("server/db.mjs"),
  ]);
  const chat = section(api, 'url.pathname === "/api/chat/messages"', 'url.pathname === "/api/answers"');

  assert.match(database, /["']text_message_limit["']\s*,\s*["']3["']/);
  assert.match(schema, /messageLimit\s*:\s*integer\(["']message_limit["']\)\.notNull\(\)\.default\(3\)/);
  assert.match(migration, /message_limit\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+3/i);
  assert.match(api, /SELECT\s+sender_id\s+FROM\s+chat_messages[\s\S]{0,180}ORDER\s+BY\s+created_at\s*,\s*id/i,
    "Turn usage must inspect messages in their stable conversation order");
  assert.match(api, /last(?:Sender|_sender)/i,
    "Adjacent messages from the same sender must be grouped into one turn");
  assert.match(chat, /startsNewTurn|newTurn|new_turn/i);
  assert.match(chat, /turn(?:_usage|s|Usage)[\s\S]{0,300}>?=\s*limit/i);
  assert.doesNotMatch(chat, /COUNT\(\*\)[\s\S]{0,160}chat_messages[\s\S]{0,160}sender_id\s*=\s*\?/i,
    "Raw per-sender message counts must not implement the paid-text quota");
  assert.doesNotMatch(chat, /limit\s*\*\s*2/,
    "The conversation must not close merely after 2N raw messages");
  assert.match(chat, /UPDATE\s+conversations\s+SET\s+status=["']closed["']/i);
});

test("keeps non-text consultations out of chat and guards conversation creation", async () => {
  const [app, api] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
  ]);
  const conversationFactory = section(api, "const ensureConversation", "const conversationPayloads");
  const payloads = section(api, "const conversationPayloads", "const recomputeLawyerRating");
  const chatApi = section(api, 'url.pathname === "/api/chat/messages"', 'url.pathname === "/api/answers"');
  const schedulePhone = section(api, 'action === "schedule-phone"', 'action === "moderate-answer"');
  const chatPanel = section(app, "function ChatPanel", "function formatBytes");

  assert.match(conversationFactory, /consultation\??\.type\s*!==\s*["']text["']|consultation\??\.type\s*===\s*["']text["']/i);
  assert.match(payloads, /c\.type\s*=\s*["']text["']/i,
    "Only paid text consultations should be returned as conversations");
  assert.match(chatApi, /consultation\??\.type\s*!==\s*["']text["']/i,
    "The message endpoint must reject phone and in-person consultations");
  assert.doesNotMatch(schedulePhone, /ensureConversation\s*\(/,
    "Scheduling a phone call must not create a chat room");
  assert.match(chatPanel, /(?:consultation_type|consultation\??\.type)\s*===\s*["']text["']/i,
    "The UI should defensively omit legacy non-text conversations");
});

test("lets admin cancel an entire free question and stops further assignment", async () => {
  const [app, api] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
  ]);
  const marker = 'action === "cancel-question"';
  const start = api.indexOf(marker);
  assert.ok(start >= 0, "Missing admin cancel-question action");
  const cancelApi = api.slice(start, start + 2_600);
  const questionAdmin = section(app, "function QuestionAssignmentPanel", "function LawyerQuestions");

  assert.match(cancelApi, /questions\.assign/);
  assert.match(cancelApi, /UPDATE\s+questions\s+SET\s+status\s*=\s*["']cancelled["']/i);
  assert.match(cancelApi, /UPDATE\s+question_assignments\s+SET\s+status\s*=\s*["']withdrawn["']/i);
  assert.match(api, /WHERE\s+q\.publish_allowed\s*=\s*1[\s\S]{0,180}q\.status\s*(?:<>|!=)\s*["']cancelled["']/i,
    "Cancelled questions must disappear from the public question feed");
  assert.ok(questionAdmin.includes("cancel-question"));
  assert.match(questionAdmin, /لغو[^<\n]{0,30}پرسش|پرسش[^<\n]{0,30}لغو/);
});

test("offers all four site-selected services with a reusable free-versus-paid notice", async () => {
  const app = await source("app/dadrah-app.tsx");
  const intake = section(app, "function IntakeModal", "function ConsultModal");
  const optionArea = section(intake, "request-types", "request-summary");

  for (const mode of ["question", "text", "phone", "in_person"]) {
    assert.ok(optionArea.includes(`"${mode}"`) || optionArea.includes(`'${mode}'`),
      `The site-selected flow is missing ${mode}`);
  }
  assert.match(optionArea, /مشاوره[^<\n]{0,20}رایگان/);
  assert.doesNotMatch(optionArea, /مشاوره متنی پولی/);
  assert.match(optionArea, /تلفنی/);
  assert.match(optionArea, /حضوری/);

  const noticeDeclaration = /function\s+([A-Z]\w*(?:Notice|Guide|Comparison)\w*)\s*\(/g;
  let notice;
  for (const match of app.matchAll(noticeDeclaration)) {
    const body = app.slice(match.index, match.index + 2_400);
    if (/رایگان/.test(body) && /پولی|پرداخت|غیررایگان/.test(body) && /پشت[\s‌-]*سر[\s‌-]*هم|متوالی/.test(body)) {
      notice = { name: match[1], body };
      break;
    }
  }
  assert.ok(notice, "A reusable notice must explain free and paid text consultations");
  assert.match(notice.body, /یک\s*(?:سؤال|پرسش)/);
  assert.match(notice.body, /نوبت/);
  const uses = app.match(new RegExp(`<${notice.name}\\b`, "g")) || [];
  assert.ok(uses.length >= 2, "The free-versus-paid notice should be reused at text-service choices");
});

test("uses the requested consultation titles and keeps specialty cards uncluttered", async () => {
  const [app, css] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("app/globals.css"),
  ]);
  const specialtyCard = section(app, "function SpecialtyCard", "function LawyersPage");

  for (const title of ["مشاوره رایگان", "مشاوره متنی", "مشاوره تلفنی", "مشاوره حضوری"]) {
    assert.ok(app.includes(title), `Missing consultation title: ${title}`);
  }
  assert.ok(!app.includes("مشاوره متنی پولی"), "The paid text option title must be shown as مشاوره متنی");
  assert.ok(!specialtyCard.includes("specialty-card-meta"), "The specialty front should not show its old detail/count footer");
  assert.ok(!specialtyCard.includes("specialty-back-reset"), "The specialty back should return automatically when hover ends");
  assert.match(specialtyCard, /onMouseLeave=/);
  assert.match(specialtyCard, /specialty-lawyers-button/);
  assert.match(css, /\.specialty-card\.is-flipped\s+\.specialty-card-inner\s*\{[^}]*rotateY\(180deg\)/i);
});

test("persists an administrator-controlled urgent surcharge and styles form controls consistently", async () => {
  const [app, api, database, schema, migration, css] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
    source("server/db.mjs"),
    source("db/schema.ts"),
    source("drizzle/0000_dadrah_core.sql"),
    source("app/globals.css"),
  ]);
  const persistence = `${database}\n${schema}\n${migration}`;

  assertIncludesEvery(persistence, ["urgent_surcharge_percent", "urgent_surcharge_rate", "urgent_surcharge_amount", "base_amount"], "Urgent pricing persistence");
  assert.match(api, /urgent\s*\?\s*settingNumber\(\s*["']urgent_surcharge_percent["']/);
  assert.match(api, /const\s+amount\s*=\s*baseAmount\s*\+\s*urgentSurchargeAmount/);
  assert.match(api, /\[\s*["']site_commission["']\s*,\s*["']urgent_surcharge_percent["']\s*\]/);
  assert.match(app, /name=["']urgentSurcharge["']/);
  assert.match(app, /urgentSurchargeAmount|urgentFee/);
  assert.match(css, /:is\(input[^{}]*select,textarea\)\s*\{[^}]*border-radius\s*:\s*7px/i);
  assert.match(css, /:focus\s*\{[^}]*box-shadow\s*:/i);
  assert.match(css, /\[data-theme=dark\][^{}]*:is\(input[^{}]*select,textarea\)/i);
});

test("shows phone attachments outside chat and themes notice and management surfaces", async () => {
  const [app, api, css] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
    source("app/globals.css"),
  ]);
  const lawyerDashboard = section(api, 'user.role === "lawyer"', 'user.role === "admin"');
  const lawyerPanel = section(app, "function LawyerPanel", "function AdminPanel");

  assert.match(api, /documentsForConsultation\s*\(/,
    "Consultation attachments need a non-chat payload path");
  assert.match(lawyerDashboard, /consultations[\s\S]{0,900}attachments/i,
    "Lawyer consultation rows must receive their attached files");
  assert.match(lawyerPanel, /attachments/i,
    "The lawyer request or case view must render consultation attachments outside ChatPanel");

  for (const selector of [".assignment-panel", ".lawyer-check-grid", ".admin-answer-list", ".control-error"]) {
    assert.ok(hasDarkRule(css, selector), `Dark mode is missing ${selector}`);
  }
  const noticeClass = /className=["']([^"']*(?:notice|comparison|difference|guide)[^"']*)["']/i.exec(app)?.[1]
    ?.split(/\s+/).find((name) => /notice|comparison|difference|guide/i.test(name));
  assert.ok(noticeClass, "The free-versus-paid notice needs a stable styling hook");
  assert.ok(hasDarkRule(css, `.${noticeClass}`), "The free-versus-paid notice needs an explicit dark-mode style");
});

test("supports cover images, controlled tags, and lawyer articles awaiting admin review", async () => {
  const [app, api, schema, migration] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
    source("db/schema.ts"),
    source("drizzle/0000_dadrah_core.sql"),
  ]);
  const articlesApi = section(api, 'url.pathname === "/api/articles"', "\n  } catch (error)");

  assertIncludesEvery(`${schema}\n${migration}`, ["author_user_id", "cover_image", "tags"], "Article persistence");
  assert.ok(api.includes("/api/article-cover"));
  assert.ok(api.includes("article_tags"));
  assert.match(articlesApi, /user\.role\s*!==\s*["']lawyer["'][^\n]{0,180}content\.manage/);
  assert.match(articlesApi, /pending_review/);
  assert.match(articlesApi, /cover_image/i);
  assert.match(articlesApi, /\btags\b/i);
  assert.match(app, /\/article-cover/);
  assert.match(app, /type=["']file["'][^>]*accept=["'][^"']*image/i);
  assert.match(app, /articleTags|article_tags|selectedTags/i);
});

test("returns role-specific notification counters and displays menu badges", async () => {
  const [app, api] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
  ]);

  assert.match(api, /const\s+notificationPayload\s*=/);
  assert.match(api, /notificationCounts\s*=\s*\{\}/);
  assert.match(api, /return\s*\{\s*notificationItems\s*,\s*notificationCounts\s*\}/);
  assert.ok(api.includes("/api/notifications/read"));
  assert.match(app, /notificationCounts\s*\[/);
  assert.match(app, /(?:menu-badge|nav-badge|notification-badge|dash-badge|menu-notification-count)/i);
  assert.match(app, /notificationItems/);
});

test("validates lawyer prices against admin ranges and categorizes verification documents", async () => {
  const [app, api, database, schema, migration] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
    source("server/db.mjs"),
    source("db/schema.ts"),
    source("drizzle/0000_dadrah_core.sql"),
  ]);

  for (const type of ["phone", "text", "in_person"]) {
    assertIncludesEvery(`${api}\n${database}`, [`${type}_price_min`, `${type}_price_max`], `${type} price range`);
  }
  assert.match(api, /const\s+priceAllowed\s*=.*price_min.*price_max/);
  assert.match(api, /!priceAllowed\(["']phone["'][\s\S]{0,240}!priceAllowed\(["']text["'][\s\S]{0,240}!priceAllowed\(["']in_person["']/);
  const profilePanel = section(app, "function ProfilePanel", "function translateType");
  assert.match(profilePanel, /prices\.map/);
  assert.match(profilePanel, /_price_min/);
  assert.match(profilePanel, /_price_max/);
  assert.match(profilePanel, /type=["']number["']/);

  assert.match(schema, /kind\s*:\s*text\(["']kind["']\)\.notNull\(\)/);
  assert.match(migration, /\bkind\s+TEXT\s+NOT\s+NULL\b/i);
  assert.match(api, /(?:verificationDocumentKinds|lawyerDocumentKinds|lawyer_document_kinds|identity_document|national_card|identity_card)/i,
    "The API must whitelist categorized lawyer verification document kinds");
  assert.match(app, /(?:identity_document|national_card|identity_card|lawyer_license|license_document)/i,
    "The lawyer verification UI must request categorized identity/license files");
});

test("lets an authorized admin verify a lawyer without hard profile or document prerequisites", async () => {
  const api = await source("server/local-api.mjs");
  const verifyLawyer = section(api, 'action === "verify-lawyer"', 'action === "set-lawyer-options"');

  assert.match(verifyLawyer, /lawyers\.verify/);
  assert.match(verifyLawyer, /UPDATE\s+lawyers\s+SET\s+verified\s*=\s*\?/i);
  assert.doesNotMatch(verifyLawyer, /profile_completed/i);
  assert.doesNotMatch(verifyLawyer, /SELECT[\s\S]{0,180}\bdocuments\b/i);
});

test("persists conversation attachments and exposes upload/download controls in chat", async () => {
  const [app, api] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
  ]);

  const uploadApi = section(api, 'url.pathname === "/api/documents"', "const documentDownload");
  assert.match(uploadApi, /consultationId|consultation_id/,
    "Conversation attachments should reuse the existing consultation document relation");
  assert.match(uploadApi, /const\s+participant\s*=\s*consultation[\s\S]{0,220}(?:client_id|lawyer_id)/i,
    "Only conversation participants may attach files");
  assert.match(api, /conversationPayloads[\s\S]{0,1800}(?:attachments|documents)/i,
    "Conversation payloads must include their attachments");

  const files = section(app, "function ConsultationFiles", "function ChatPanel");
  const chat = section(app, "function ChatPanel", "function formatBytes");
  assert.match(chat, /<ConsultationFiles\b/,
    "The active chat should render its consultation attachments");
  assert.match(files, /type=["']file["']/);
  assert.match(files, /FormData\s*\(/);
  assert.match(files, /consultationId|consultation_id/);
  assert.match(files, /\/documents/);
  assert.match(files, /downloadProtectedDocument/);
});

test("derives article category from administrator-controlled tags and removes category entry from article UI", async () => {
  const [app, api] = await Promise.all([
    source("app/dadrah-app.tsx"),
    source("server/local-api.mjs"),
  ]);
  const articlesApi = section(api, 'url.pathname === "/api/articles"', "\n  } catch (error)");
  const contentManager = section(app, "function ContentManager", "function ServicesManager");
  const articleForm = section(contentManager, 'showForm&&section==="articles"', 'showForm&&section==="faqs"');

  assert.doesNotMatch(articlesApi, /validText\(body\.category/);
  assert.match(articlesApi, /const\s+category\s*=\s*tags\s*\[\s*0\s*\]/);
  assert.doesNotMatch(articleForm, /name=["']category["']/,
    "Article authors should choose controlled tags instead of typing a free-form category");
  assert.match(articleForm, /article-tag-picker/);
  assert.match(articleForm, /allowedTags\.map/);
});

test("shows tracking codes in consultation views, not only in the payments tab", async () => {
  const app = await source("app/dadrah-app.tsx");
  const clientPanel = section(app, "function ClientPanel", "function LawyerPanel");
  const consultationsView = section(clientPanel, 'tab==="consultations"', 'tab==="appointments"');
  const trackingCode = section(app, "function TrackingCode", "function ConsultationProgress");

  assert.match(trackingCode, /tracking_code/);
  assert.match(consultationsView, /<TrackingCode\b[^>]*item=\{x\}/,
    "The consultation table should render the user-facing tracking code helper");
});

test("keeps quota banners, checkboxes, and upload lists visually constrained", async () => {
  const css = await source("app/globals.css");

  const quotaRule = declarationsFor(css, ".chat-quota");
  assert.ok(quotaRule, "Missing .chat-quota styles");
  const quotaPadding = /padding\s*:\s*(\d+)px/i.exec(quotaRule);
  assert.ok(quotaPadding && Number(quotaPadding[1]) <= 8,
    "The message quota banner should use compact vertical padding");
  assert.match(quotaRule, /display\s*:\s*(?:flex|grid)/i);

  assert.match(css, /input\[type=checkbox\][^{}]*\{[^}]*width\s*:\s*(?:1[4-9]|20)px(?:!important)?[^}]*height\s*:\s*(?:1[4-9]|20)px(?:!important)?/i,
    "Dashboard checkboxes need explicit compact dimensions");
  const uploadListRule = `${declarationsFor(css, ".document-list")};${declarationsFor(css, ".conversation-file-list")}`;
  assert.ok(uploadListRule.replaceAll(";", "").trim(), "Missing upload-list container styles");
  assert.match(uploadListRule, /max-height\s*:/i);
  assert.match(uploadListRule, /overflow(?:-y)?\s*:\s*(?:auto|scroll)/i);
});

test("allows a client to rebook completed consultations in all three service modes", async () => {
  const app = await source("app/dadrah-app.tsx");
  const clientPanel = section(app, "function ClientPanel", "function LawyerPanel");

  assert.match(clientPanel, /rebook|bookAgain|repeatConsultation/i,
    "Completed consultation rows need a dedicated rebooking action");
  const rebooking = section(app, /function\s+(?:Rebook\w*|\w*Rebook\w*)/.exec(app)?.[0] || "rebook", "function ClientPanel");
  assert.match(rebooking, /completed/);
  for (const mode of ["phone", "text", "in_person"]) {
    assert.ok(rebooking.includes(`"${mode}"`) || rebooking.includes(`'${mode}'`), `Rebooking is missing ${mode}`);
  }
  assert.match(rebooking, /\/consultations/);
});
