import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const dbPath = resolve("data/dadrah.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [salt, key] = String(stored || "").split(":");
  if (!salt || !/^[a-f0-9]{128}$/i.test(key || "")) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(key, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function ensureColumn(table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function installSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('client','lawyer','admin')),
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      province TEXT,
      city TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lawyers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
      license_number TEXT NOT NULL,
      specialties TEXT NOT NULL,
      bio TEXT NOT NULL,
      phone_price INTEGER NOT NULL,
      text_price INTEGER NOT NULL DEFAULT 0,
      in_person_price INTEGER,
      rating REAL NOT NULL DEFAULT 0,
      verified INTEGER NOT NULL DEFAULT 0,
      featured INTEGER NOT NULL DEFAULT 0,
      online INTEGER NOT NULL DEFAULT 0,
      in_person_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES users(id),
      lawyer_id INTEGER REFERENCES lawyers(id),
      topic TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'public',
      status TEXT NOT NULL DEFAULT 'new',
      publish_allowed INTEGER NOT NULL DEFAULT 0,
      urgent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS question_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      lawyer_id INTEGER NOT NULL REFERENCES lawyers(id) ON DELETE CASCADE,
      assigned_by INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'assigned',
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(question_id, lawyer_id)
    );
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
      body TEXT NOT NULL,
      published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS appointment_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      consultation_type TEXT NOT NULL DEFAULT 'phone',
      status TEXT NOT NULL DEFAULT 'available'
    );
    CREATE TABLE IF NOT EXISTS consultations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES users(id),
      lawyer_id INTEGER REFERENCES lawyers(id),
      slot_id INTEGER REFERENCES appointment_slots(id),
      type TEXT NOT NULL,
      topic TEXT NOT NULL,
      scheduled_at TEXT,
      amount INTEGER NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'simulated_paid',
      status TEXT NOT NULL DEFAULT 'registered',
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES users(id),
      consultation_id INTEGER REFERENCES consultations(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      commission_rate REAL NOT NULL DEFAULT 0,
      commission_amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'paid',
      tracking_code TEXT NOT NULL,
      paid_at TEXT,
      refunded_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES users(id),
      lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
      consultation_id INTEGER REFERENCES consultations(id),
      consultation_type TEXT NOT NULL,
      body TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(consultation_id)
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES users(id),
      lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_id, lawyer_id)
    );
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL,
      author TEXT NOT NULL,
      cover_image TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      author_avatar TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      icon TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS faqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      lawyer_id INTEGER REFERENCES lawyers(id),
      question_id INTEGER REFERENCES questions(id),
      consultation_id INTEGER REFERENCES consultations(id),
      kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      path TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consultation_id INTEGER NOT NULL UNIQUE REFERENCES consultations(id) ON DELETE CASCADE,
      client_id INTEGER NOT NULL REFERENCES users(id),
      lawyer_id INTEGER NOT NULL REFERENCES lawyers(id),
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admin_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1,
      UNIQUE(admin_id, permission)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      order_code TEXT,
      admin_reply TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
  `);

  ensureColumn("questions", "urgent", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("appointment_slots", "consultation_type", "TEXT NOT NULL DEFAULT 'phone'");
  ensureColumn("consultations", "slot_id", "INTEGER REFERENCES appointment_slots(id)");
  ensureColumn("consultations", "completed_at", "TEXT");
  ensureColumn("orders", "type", "TEXT NOT NULL DEFAULT 'phone'");
  ensureColumn("orders", "commission_rate", "REAL NOT NULL DEFAULT 0");
  ensureColumn("orders", "commission_amount", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("orders", "paid_at", "TEXT");
  ensureColumn("orders", "refunded_at", "TEXT");
  ensureColumn("reviews", "consultation_id", "INTEGER REFERENCES consultations(id)");
  ensureColumn("documents", "lawyer_id", "INTEGER REFERENCES lawyers(id)");
  ensureColumn("documents", "question_id", "INTEGER REFERENCES questions(id)");
  ensureColumn("documents", "consultation_id", "INTEGER REFERENCES consultations(id)");
  ensureColumn("documents", "mime_type", "TEXT NOT NULL DEFAULT 'application/octet-stream'");
  ensureColumn("documents", "size_bytes", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("messages", "order_code", "TEXT");
  ensureColumn("messages", "admin_reply", "TEXT");
  ensureColumn("messages", "updated_at", "TEXT");
  ensureColumn("articles", "cover_image", "TEXT");
  ensureColumn("articles", "tags", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("articles", "author_avatar", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS questions_status_idx ON questions(status);
    CREATE INDEX IF NOT EXISTS question_assignments_lawyer_idx ON question_assignments(lawyer_id, status);
    CREATE INDEX IF NOT EXISTS question_assignments_question_idx ON question_assignments(question_id);
    CREATE INDEX IF NOT EXISTS consultations_client_idx ON consultations(client_id);
    CREATE INDEX IF NOT EXISTS consultations_lawyer_idx ON consultations(lawyer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS consultations_slot_unique_idx ON consultations(slot_id) WHERE slot_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS reviews_consultation_unique_idx ON reviews(consultation_id) WHERE consultation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS appointment_slots_lawyer_idx ON appointment_slots(lawyer_id, starts_at);
    CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS documents_question_idx ON documents(question_id);
    CREATE INDEX IF NOT EXISTS documents_consultation_idx ON documents(consultation_id);
    CREATE INDEX IF NOT EXISTS messages_user_idx ON messages(user_id, created_at);
    CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id, created_at);
  `);
}

const adminPermissionNames = [
  "users.manage", "lawyers.verify", "questions.assign", "consultations.manage",
  "content.manage", "services.manage", "reviews.manage", "support.manage",
  "documents.manage", "finance.view", "payments.manage", "reports.view",
  "settings.manage", "admins.manage",
];

function addSeedUsers() {
  const addUser = db.prepare("INSERT OR IGNORE INTO users (username,password_hash,role,first_name,last_name,email,phone,province,city,status) VALUES (?,?,?,?,?,?,?,?,?,'active')");
  addUser.run("client", hashPassword("Client123!"), "client", "علی", "رضایی", "client@dadrah.local", "09121234567", "تهران", "تهران");
  addUser.run("demo.client2", hashPassword("DemoClient123!"), "client", "سپیده", "محمدی", "demo.client2@dadrah.local", "09120000022", "اصفهان", "اصفهان");
  addUser.run("demo.client3", hashPassword("DemoClient123!"), "client", "نوید", "عزیزی", "demo.client3@dadrah.local", "09120000033", "فارس", "شیراز");
  addUser.run("lawyer", hashPassword("Lawyer123!"), "lawyer", "نازنین", "فرهمند", "lawyer@dadrah.local", "09123334455", "تهران", "تهران");
  addUser.run("lawyer.pending", hashPassword("Pending123!"), "lawyer", "مهسا", "کریمی", "pending-lawyer@dadrah.local", "09123334477", "البرز", "کرج");
  addUser.run("admin", hashPassword("Admin123!"), "admin", "مدیر", "اصلی", "admin@dadrah.local", "02191092020", "تهران", "تهران");
  [
    ["lawyer2", "امیرحسین", "دادخواه", "lawyer2@dadrah.local", "09123334456", "فارس", "شیراز"],
    ["lawyer3", "سارا", "نیک‌اندیش", "lawyer3@dadrah.local", "09123334457", "اصفهان", "اصفهان"],
    ["lawyer4", "محمدرضا", "توکلی", "lawyer4@dadrah.local", "09123334458", "تهران", "تهران"],
    ["lawyer5", "الهام", "رستگار", "lawyer5@dadrah.local", "09123334459", "آذربایجان شرقی", "تبریز"],
    ["lawyer6", "پویان", "شریعتی", "lawyer6@dadrah.local", "09123334460", "خراسان رضوی", "مشهد"],
  ].forEach(([username, firstName, lastName, email, phone, province, city]) => {
    addUser.run(username, hashPassword("Lawyer123!"), "lawyer", firstName, lastName, email, phone, province, city);
  });
}

function addSeedLawyers() {
  const addLawyer = db.prepare("INSERT OR IGNORE INTO lawyers (id,user_id,license_number,specialties,bio,phone_price,text_price,in_person_price,rating,verified,featured,online,in_person_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  [
    [1, "lawyer", "23456", "خانواده و طلاق", "وکیل پایه یک دادگستری با تمرکز بر پرونده‌های خانواده و ۱۲ سال سابقه حرفه‌ای", 480000, 850000, 4.9, 1, 1],
    [2, "lawyer2", "19874", "دعاوی کیفری", "متخصص دفاع کیفری و پیگیری پرونده از تحقیقات مقدماتی تا دادگاه", 550000, 900000, 4.8, 1, 1],
    [3, "lawyer3", "28110", "ملکی و قراردادها", "مشاور حقوقی قراردادها و دعاوی ملکی با رویکرد پیشگیرانه", 420000, 780000, 4.7, 0, 0],
    [4, "lawyer4", "15602", "تجاری و شرکت‌ها", "همراه حقوقی کسب‌وکارها در قراردادها، ساختار شرکتی و اختلاف شرکا", 620000, 1100000, 4.9, 1, 1],
    [5, "lawyer5", "31098", "ارث و امور ثبتی", "پیگیری پرونده‌های ارث، تقسیم ترکه و امور ثبتی به‌صورت مرحله‌به‌مرحله", 390000, 720000, 4.6, 0, 0],
    [6, "lawyer6", "22701", "کار و تأمین اجتماعی", "مشاور روابط کار، مطالبات مزدی، بیمه و اختلافات کارگر و کارفرما", 450000, 760000, 4.8, 0, 1],
  ].forEach(([id, username, license, specialties, bio, phonePrice, inPersonPrice, rating, featured, online]) => {
    const user = db.prepare("SELECT id FROM users WHERE username=?").get(username);
    if (user) addLawyer.run(id, user.id, license, specialties, bio, phonePrice, 0, inPersonPrice, rating, 1, featured, online, 1);
  });
  const pendingUser = db.prepare("SELECT id FROM users WHERE username='lawyer.pending'").get();
  if (pendingUser) {
    addLawyer.run(7, pendingUser.id, "در انتظار بررسی ۴۴۷۱۰", "حقوق مالیاتی", "پروفایل تازه ثبت شده و در انتظار بررسی مدارک و شماره پروانه توسط مدیر سامانه است.", 440000, 0, 800000, 0, 0, 0, 0, 0);
  }
}

function addSeedContent() {
  const addArticle = db.prepare("INSERT OR IGNORE INTO articles(slug,title,excerpt,body,category,author,cover_image,tags,author_avatar,status,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const articleSeeds = [
    ["mehrieh-guide", "راهنمای کامل مطالبه مهریه در سال ۱۴۰۵", "از انتخاب مسیر اجرا تا مدارک و هزینه‌ها را ساده و مرحله‌به‌مرحله بخوانید.", "مطالبه مهریه می‌تواند از اجرای ثبت یا دادگاه خانواده آغاز شود. انتخاب مسیر به وجود سند رسمی، دارایی‌های قابل شناسایی و شرایط پرونده بستگی دارد.", "خانواده", "تحریریه دادراه", "/blog/covers/mehrieh-guide.webp", JSON.stringify(["مهریه", "خانواده", "اجرای ثبت"]), "/blog/authors/dadrah-editorial.svg", "published", "2026-08-28"],
    ["contract-seven-clauses", "۷ بند مهم پیش از امضای قرارداد", "این بندها جلوی بسیاری از اختلاف‌های پرهزینه را می‌گیرند.", "موضوع قرارداد، تعهدات هر طرف، مبلغ و شیوه پرداخت، تضمین‌ها، خسارت تأخیر، شرایط فسخ و مرجع حل اختلاف باید صریح باشند.", "قراردادها", "سارا نیک‌اندیش", "/blog/covers/contract-seven-clauses.webp", JSON.stringify(["قرارداد", "کسب‌وکار", "حل اختلاف"]), "/blog/authors/sara-nikandish.webp", "published", "2026-08-21"],
    ["property-checks", "استعلام‌های ضروری پیش از خرید ملک", "پیش از پرداخت بیعانه این بررسی‌ها را جدی بگیرید.", "اصالت سند، هویت مالک، بازداشت یا رهن، بدهی شهرداری، پایان کار و تطبیق مشخصات ملک با سند باید بررسی شوند.", "ملکی", "تحریریه دادراه", "/blog/covers/property-checks.webp", JSON.stringify(["ملک", "استعلام", "خرید امن"]), "/blog/authors/dadrah-editorial.svg", "published", "2026-08-15"],
  ];
  const hydrateArticleMedia = db.prepare(`
    UPDATE articles
    SET cover_image=CASE WHEN cover_image IS NULL OR cover_image='' THEN ? ELSE cover_image END,
        tags=CASE WHEN tags IS NULL OR tags='' OR tags='[]' THEN ? ELSE tags END,
        author_avatar=CASE WHEN author_avatar IS NULL OR author_avatar='' THEN ? ELSE author_avatar END
    WHERE slug=?
  `);
  articleSeeds.forEach((article) => {
    addArticle.run(...article);
    hydrateArticleMedia.run(article[6], article[7], article[8], article[0]);
  });

  const addService = db.prepare("INSERT OR IGNORE INTO services(title,description,icon,sort_order) VALUES(?,?,?,?)");
  [
    ["دعاوی کیفری", "دفاع و پیگیری تخصصی در دادسرا و دادگاه", "shield", 1],
    ["خانواده و طلاق", "مهریه، حضانت، نفقه و اختلافات خانوادگی", "heart", 2],
    ["دعاوی ملکی", "سند، سرقفلی، اجاره و مشارکت در ساخت", "building", 3],
    ["قرارداد و تجارت", "تنظیم و بررسی قراردادها و اختلاف شرکا", "briefcase", 4],
    ["چک و اسناد", "چک، سفته، مطالبات و ضمانت‌ها", "file-check", 5],
    ["ارث و ثبت", "انحصار وراثت، تقسیم ترکه و امور ثبتی", "landmark", 6],
  ].forEach((item) => addService.run(...item));

  const addFaq = db.prepare("INSERT OR IGNORE INTO faqs(category,question,answer,sort_order) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM faqs WHERE question=?)");
  [
    ["اعتماد", "آیا اطلاعات و مدارک من محرمانه می‌ماند؟", "بله. اطلاعات فقط در اختیار وکیل مرتبط و مدیران مجاز قرار می‌گیرد و بدون رضایت شما منتشر نمی‌شود.", 1],
    ["انتخاب وکیل", "اگر ندانم کدام وکیل مناسب است چه کنم؟", "موضوع را رایگان ثبت کنید تا مدیر پرونده آن را به چند وکیل مرتبط ارجاع دهد.", 2],
    ["مشاوره", "مشاوره تلفنی چقدر طول می‌کشد؟", "هر جلسه حداکثر ۳۰ دقیقه است و زمان تماس در درخواست شما ثبت می‌شود.", 3],
  ].forEach((item) => addFaq.run(...item, item[1]));
}

function addSeedSettings() {
  const admin = db.prepare("SELECT id FROM users WHERE username='admin' AND role='admin'").get();
  if (!admin) return;
  adminPermissionNames.forEach((permission) => db.prepare("INSERT OR IGNORE INTO admin_permissions(admin_id,permission) VALUES(?,?)").run(admin.id, permission));
  [
    ["site_name", "دادراه"], ["site_commission", "15"],
    ["default_phone_price", "480000"], ["default_in_person_price", "850000"],
    ["support_phone", "02191092020"], ["support_email", "support@dadrah.ir"],
    ["support_address", "تهران، میدان ونک"], ["questions_enabled", "1"],
    ["global_in_person_enabled", "1"], ["maintenance_mode", "0"],
    ["primary_admin_id", String(admin.id)], ["primary_admin_username", "admin"],
  ].forEach((item) => db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)").run(...item));
  const configuredPrimary = Number(db.prepare("SELECT value FROM settings WHERE key='primary_admin_id'").get()?.value);
  if (!Number.isSafeInteger(configuredPrimary) || !db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin'").get(configuredPrimary)) {
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('primary_admin_id',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(String(admin.id));
  }
}

function addSeedWorkflow() {
  const client = db.prepare("SELECT id FROM users WHERE username='client'").get();
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
  const lawyer = db.prepare("SELECT id,user_id,phone_price FROM lawyers WHERE id=1").get();
  if (!client || !admin || !lawyer) return;

  if (db.prepare("SELECT COUNT(*) count FROM questions").get().count === 0) {
    const answered = db.prepare("INSERT INTO questions(client_id,lawyer_id,topic,body,kind,status,publish_allowed,urgent) VALUES(?,?,?,?,?,?,?,?)").run(client.id, lawyer.id, "فسخ قرارداد اجاره", "در قرارداد من شرط فسخ نوشته شده است؛ برای استفاده از آن چه مدارکی لازم دارم؟", "direct", "answered", 1, 0);
    db.prepare("INSERT INTO question_assignments(question_id,lawyer_id,assigned_by,status) VALUES(?,?,?,'answered')").run(answered.lastInsertRowid, lawyer.id, admin.id);
    db.prepare("INSERT INTO answers(question_id,lawyer_id,body,published) VALUES(?,?,?,1)").run(answered.lastInsertRowid, lawyer.id, "ابتدا متن دقیق شرط فسخ، رسیدهای پرداخت و همه مکاتبات را آماده کنید. امکان استفاده از شرط به عبارت قرارداد و انجام تعهدات هر دو طرف بستگی دارد.");
    db.prepare("INSERT INTO questions(client_id,topic,body,kind,status,publish_allowed,urgent) VALUES(?,?,?,?,?,?,?)").run(client.id, "مطالبه وجه چک", "برای چکی که در موعد پرداخت نشده، سریع‌ترین مسیر قانونی و مدارک مورد نیاز چیست؟", "public", "pending_assignment", 0, 1);
  }

  if (db.prepare("SELECT COUNT(*) count FROM consultations").get().count === 0) {
    const start = new Date(Date.now() - 7 * 86400000).toISOString();
    const end = new Date(Date.now() - 7 * 86400000 + 30 * 60000).toISOString();
    const slot = db.prepare("INSERT INTO appointment_slots(lawyer_id,starts_at,ends_at,consultation_type,status) VALUES(?,?,?,'phone','booked')").run(lawyer.id, start, end);
    const consultation = db.prepare("INSERT INTO consultations(client_id,lawyer_id,slot_id,type,topic,scheduled_at,amount,payment_status,status,completed_at) VALUES(?,?,?,?,?,?,?,'simulated_paid','completed',?)").run(client.id, lawyer.id, slot.lastInsertRowid, "phone", "بررسی قرارداد اجاره", start, lawyer.phone_price, end);
    const rate = Number(db.prepare("SELECT value FROM settings WHERE key='site_commission'").get()?.value || 15);
    const commission = Math.round(lawyer.phone_price * rate / 100);
    db.prepare("INSERT INTO orders(client_id,consultation_id,type,amount,commission_rate,commission_amount,status,tracking_code,paid_at) VALUES(?,?,?,?,?,?,'paid',?,?)").run(client.id, consultation.lastInsertRowid, "phone", lawyer.phone_price, rate, commission, "DR-DEMO-1405", start);
    const conversation = db.prepare("INSERT INTO conversations(consultation_id,client_id,lawyer_id,status) VALUES(?,?,?,'closed')").run(consultation.lastInsertRowid, client.id, lawyer.id);
    db.prepare("INSERT INTO chat_messages(conversation_id,sender_id,body,created_at) VALUES(?,?,?,?)").run(conversation.lastInsertRowid, client.id, "سلام، متن قرارداد را پیش از تماس بارگذاری کرده‌ام.", start);
    db.prepare("INSERT INTO chat_messages(conversation_id,sender_id,body,created_at) VALUES(?,?,?,?)").run(conversation.lastInsertRowid, lawyer.user_id, "دریافت شد؛ بند فسخ را در جلسه با هم بررسی می‌کنیم.", end);
    db.prepare("INSERT INTO reviews(client_id,lawyer_id,consultation_id,consultation_type,body,rating,status) VALUES(?,?,?,?,?,5,'approved')").run(client.id, lawyer.id, consultation.lastInsertRowid, "phone", "توضیحات روشن و کاربردی بود و مسیر بعدی پرونده را دقیق متوجه شدم.");
    db.prepare("INSERT OR IGNORE INTO bookmarks(client_id,lawyer_id) VALUES(?,?)").run(client.id, lawyer.id);
  }

  if (!db.prepare("SELECT 1 FROM appointment_slots WHERE lawyer_id=? AND status='available' AND datetime(starts_at)>datetime('now') LIMIT 1").get(lawyer.id)) {
    const start = new Date(Date.now() + 2 * 86400000);
    start.setUTCHours(14, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60000);
    db.prepare("INSERT INTO appointment_slots(lawyer_id,starts_at,ends_at,consultation_type,status) VALUES(?,?,?,'in_person','available')").run(lawyer.id, start.toISOString(), end.toISOString());
  }
  const verifiedLawyers = db.prepare("SELECT id,in_person_enabled FROM lawyers WHERE verified=1 ORDER BY id").all();
  const addAvailableSlot = db.prepare("INSERT INTO appointment_slots(lawyer_id,starts_at,ends_at,consultation_type,status) VALUES(?,?,?,?,'available')");
  for (const item of verifiedLawyers) {
    const currentCount = db.prepare("SELECT COUNT(*) count FROM appointment_slots WHERE lawyer_id=? AND status='available' AND datetime(starts_at)>datetime('now')").get(item.id).count;
    for (let index = currentCount; index < 2; index += 1) {
      const start = new Date(Date.now() + (item.id + index + 1) * 86400000);
      start.setUTCHours(index ? 16 : 12, 30, 0, 0);
      const end = new Date(start.getTime() + 30 * 60000);
      const type = item.in_person_enabled && index === 0 ? "in_person" : "phone";
      addAvailableSlot.run(item.id, start.toISOString(), end.toISOString(), type);
    }
  }

  const demoReviews = [
    {
      username: "demo.client2",
      lawyerId: 2,
      type: "in_person",
      topic: "پیگیری پرونده کیفری",
      trackingCode: "DR-DEMO-REVIEW-2",
      daysAgo: 18,
      rating: 5,
      body: "جلسه بسیار منظم بود؛ مدارک لازم و مراحل بعدی پرونده را روشن و بدون ابهام توضیح دادند.",
    },
    {
      username: "demo.client3",
      lawyerId: 4,
      type: "phone",
      topic: "بازبینی قرارداد شراکت",
      trackingCode: "DR-DEMO-REVIEW-3",
      daysAgo: 11,
      rating: 5,
      body: "نکته‌های پرریسک قرارداد دقیق مشخص شد و پیشنهادهای اصلاحی همان روز قابل استفاده بود.",
    },
  ];
  for (const seed of demoReviews) {
    if (db.prepare("SELECT 1 FROM orders WHERE tracking_code=?").get(seed.trackingCode)) continue;
    const demoClient = db.prepare("SELECT id FROM users WHERE username=?").get(seed.username);
    const demoLawyer = db.prepare("SELECT id,user_id,phone_price,in_person_price FROM lawyers WHERE id=?").get(seed.lawyerId);
    if (!demoClient || !demoLawyer) continue;
    const start = new Date(Date.now() - seed.daysAgo * 86400000);
    start.setUTCHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60000);
    const slot = db.prepare("INSERT INTO appointment_slots(lawyer_id,starts_at,ends_at,consultation_type,status) VALUES(?,?,?,?,'booked')").run(demoLawyer.id, start.toISOString(), end.toISOString(), seed.type);
    const amount = seed.type === "phone" ? demoLawyer.phone_price : demoLawyer.in_person_price;
    const consultation = db.prepare("INSERT INTO consultations(client_id,lawyer_id,slot_id,type,topic,scheduled_at,amount,payment_status,status,completed_at) VALUES(?,?,?,?,?,?,?,'simulated_paid','completed',?)").run(demoClient.id, demoLawyer.id, slot.lastInsertRowid, seed.type, seed.topic, start.toISOString(), amount, end.toISOString());
    const rate = Number(db.prepare("SELECT value FROM settings WHERE key='site_commission'").get()?.value || 15);
    const commission = Math.round(amount * rate / 100);
    db.prepare("INSERT INTO orders(client_id,consultation_id,type,amount,commission_rate,commission_amount,status,tracking_code,paid_at) VALUES(?,?,?,?,?,?,'paid',?,?)").run(demoClient.id, consultation.lastInsertRowid, seed.type, amount, rate, commission, seed.trackingCode, start.toISOString());
    db.prepare("INSERT INTO conversations(consultation_id,client_id,lawyer_id,status) VALUES(?,?,?,'closed')").run(consultation.lastInsertRowid, demoClient.id, demoLawyer.id);
    db.prepare("INSERT INTO reviews(client_id,lawyer_id,consultation_id,consultation_type,body,rating,status) VALUES(?,?,?,?,?,?,'approved')").run(demoClient.id, demoLawyer.id, consultation.lastInsertRowid, seed.type, seed.body, seed.rating);
  }
  if (!db.prepare("SELECT 1 FROM messages WHERE subject='پیگیری جمع‌بندی مشاوره' LIMIT 1").get()) {
    db.prepare("INSERT INTO messages(user_id,name,phone,kind,subject,body,order_code,status,updated_at) VALUES(?,?,?,?,?,?,?,'new',CURRENT_TIMESTAMP)").run(
      client.id,
      "علی رضایی",
      "09121234567",
      "support",
      "پیگیری جمع‌بندی مشاوره",
      "لطفاً وضعیت ثبت جمع‌بندی جلسه آزمایشی را بررسی کنید.",
      "DR-DEMO-1405",
    );
  }
  db.prepare("UPDATE lawyers SET rating=COALESCE((SELECT ROUND(AVG(rating),1) FROM reviews WHERE lawyer_id=lawyers.id AND status='approved'),rating)").run();
}

function backfillNewFields() {
  const rate = Number(db.prepare("SELECT value FROM settings WHERE key='site_commission'").get()?.value || 15);
  db.prepare("UPDATE orders SET commission_rate=? WHERE commission_rate IS NULL OR commission_rate=0").run(rate);
  db.prepare("UPDATE orders SET commission_amount=ROUND(amount*commission_rate/100.0) WHERE commission_amount IS NULL OR commission_amount=0").run();
  db.prepare("UPDATE orders SET paid_at=COALESCE(paid_at,created_at) WHERE status='paid'").run();
  db.prepare("UPDATE messages SET updated_at=COALESCE(updated_at,created_at,CURRENT_TIMESTAMP)").run();
}

export function migrate() {
  installSchema();
  addSeedUsers();
  addSeedLawyers();
  addSeedContent();
  addSeedSettings();
  backfillNewFields();
  addSeedWorkflow();
}

export function currentUser(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  return db.prepare(`
    SELECT u.id,u.username,u.role,u.first_name,u.last_name,u.email,u.phone,u.province,u.city,u.status,u.created_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND datetime(s.expires_at)>datetime('now') AND u.status='active'
  `).get(token) ?? null;
}
