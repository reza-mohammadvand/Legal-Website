import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { db, dbPath, migrate, verifyPassword, hashPassword, currentUser } from "./db.mjs";

migrate();

const port = Number(process.env.DADRAH_API_PORT || 8787);
const maxJsonBytes = 1024 * 1024;
const maxFileBytes = 10 * 1024 * 1024;
const uploadsDirectory = resolve("data/uploads");
mkdirSync(uploadsDirectory, { recursive: true });

const permissionNames = [
  "users.manage", "lawyers.verify", "questions.assign", "consultations.manage",
  "content.manage", "services.manage", "reviews.manage", "support.manage",
  "documents.manage", "finance.view", "payments.manage", "reports.view",
  "settings.manage", "admins.manage",
];
const adminPermissionNames = new Set(permissionNames);
const publicSettingNames = new Set([
  "site_name", "support_phone", "support_email", "support_address",
  "default_phone_price", "default_in_person_price", "questions_enabled",
  "global_in_person_enabled", "maintenance_mode",
]);

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const json = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  if (status === 204) return res.end();
  return res.end(JSON.stringify(data));
};

const readRawBody = async (req, limit) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
};

const readBody = async (req) => {
  const body = await readRawBody(req, maxJsonBytes);
  try {
    const parsed = JSON.parse(body.toString("utf8") || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw new ApiError(400, "INVALID_JSON");
  }
};

const bearerToken = (req) => req.headers.authorization?.replace(/^Bearer\s+/i, "").trim() || "";
const normalizeUsername = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();
const cleanText = (value) => String(value ?? "").normalize("NFKC").trim();
const validText = (value, min, max) => {
  const text = cleanText(value);
  return text.length >= min && text.length <= max ? text : null;
};
const validId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const validIsoFuture = (value, optional = false) => {
  if ((value === null || value === undefined || value === "") && optional) return null;
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return undefined;
  const time = Date.parse(text);
  if (!Number.isFinite(time) || time <= Date.now()) return undefined;
  return new Date(time).toISOString();
};
const accountFor = (userId) => db.prepare("SELECT id,username,role,first_name,last_name,email,phone,province,city,status,created_at FROM users WHERE id=?").get(userId);
const lawyerForUser = (userId) => db.prepare("SELECT * FROM lawyers WHERE user_id=?").get(userId);

const primaryAdminId = () => Number(db.prepare("SELECT value FROM settings WHERE key='primary_admin_id'").get()?.value || 0);
const isPrimaryAdmin = (user) => user?.role === "admin" && user.id === primaryAdminId();
const hasAdminPermission = (user, permission) => {
  if (user?.role !== "admin" || !adminPermissionNames.has(permission)) return false;
  return isPrimaryAdmin(user) || Boolean(db.prepare("SELECT 1 FROM admin_permissions WHERE admin_id=? AND permission=? AND allowed=1").get(user.id, permission));
};
const hasAnyAdminPermission = (user, permissions) => permissions.some((permission) => hasAdminPermission(user, permission));

const parseMultipart = async (req) => {
  const contentType = String(req.headers["content-type"] || "");
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || "").trim();
  if (!contentType.toLowerCase().startsWith("multipart/form-data") || !boundary || !/^[0-9A-Za-z'()+_,.\/:=?-]{1,200}$/.test(boundary)) {
    throw new ApiError(415, "INVALID_MULTIPART");
  }
  const body = await readRawBody(req, maxFileBytes + 256 * 1024);
  const marker = Buffer.from(`--${boundary}`);
  const nextMarker = Buffer.from(`\r\n--${boundary}`);
  const headerEndMarker = Buffer.from("\r\n\r\n");
  let cursor = body.indexOf(marker);
  let file = null;
  const fields = {};
  if (cursor !== 0) throw new ApiError(400, "INVALID_MULTIPART");
  while (cursor >= 0) {
    cursor += marker.length;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) throw new ApiError(400, "INVALID_MULTIPART");
    cursor += 2;
    const headerEnd = body.indexOf(headerEndMarker, cursor);
    if (headerEnd < 0 || headerEnd - cursor > 16 * 1024) throw new ApiError(400, "INVALID_MULTIPART");
    const headers = {};
    for (const line of body.subarray(cursor, headerEnd).toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const disposition = String(headers["content-disposition"] || "");
    const name = /\bname="([^"]+)"/i.exec(disposition)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    const contentStart = headerEnd + headerEndMarker.length;
    const nextBoundary = body.indexOf(nextMarker, contentStart);
    if (!name || nextBoundary < 0) throw new ApiError(400, "INVALID_MULTIPART");
    const value = body.subarray(contentStart, nextBoundary);
    if (filename !== undefined) {
      if (file) throw new ApiError(400, "TOO_MANY_FILES");
      file = { buffer: value, fileName: filename, declaredType: String(headers["content-type"] || "").toLowerCase().split(";")[0].trim() };
    } else {
      if (value.length > 4096) throw new ApiError(400, "INVALID_MULTIPART_FIELD");
      fields[name] = value.toString("utf8");
    }
    cursor = nextBoundary + 2;
  }
  if (!file?.fileName) throw new ApiError(400, "FILE_REQUIRED");
  if (!file.buffer.length || file.buffer.length > maxFileBytes) throw new ApiError(file.buffer.length > maxFileBytes ? 413 : 400, "FILE_SIZE_INVALID");
  return { file, fields };
};

const inspectUpload = (file) => {
  let mimeType;
  let extension;
  const pdfEof = file.buffer.lastIndexOf("%%EOF");
  const pngIend = file.buffer.lastIndexOf(Buffer.from("IEND"));
  if (file.buffer.length >= 9 && file.buffer.subarray(0, 5).toString("ascii") === "%PDF-" && pdfEof >= file.buffer.length - 1024) {
    mimeType = "application/pdf";
    extension = ".pdf";
  } else if (file.buffer.length >= 4 && file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff && file.buffer.at(-2) === 0xff && file.buffer.at(-1) === 0xd9) {
    mimeType = "image/jpeg";
    extension = ".jpg";
  } else if (file.buffer.length >= 33 && file.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && file.buffer.subarray(12, 16).toString("ascii") === "IHDR" && pngIend >= file.buffer.length - 16) {
    mimeType = "image/png";
    extension = ".png";
  } else {
    throw new ApiError(415, "UNSUPPORTED_FILE");
  }
  const originalExtension = extname(file.fileName).toLowerCase();
  const allowedExtensions = mimeType === "image/jpeg" ? new Set([".jpg", ".jpeg"]) : new Set([extension]);
  if (!allowedExtensions.has(originalExtension)) throw new ApiError(415, "FILE_EXTENSION_MISMATCH");
  if (file.declaredType && !["application/octet-stream", mimeType].includes(file.declaredType)) throw new ApiError(415, "FILE_MIME_MISMATCH");
  return { mimeType, extension };
};

const publicDocument = (row) => row && ({
  id: row.id,
  owner_id: row.owner_id,
  owner_name: row.owner_name,
  lawyer_id: row.lawyer_id,
  lawyer_name: row.lawyer_name,
  question_id: row.question_id,
  consultation_id: row.consultation_id,
  kind: row.kind,
  file_name: row.file_name,
  mime_type: row.mime_type,
  size_bytes: row.size_bytes,
  status: row.status,
  created_at: row.created_at,
  download_url: `/api/documents/${row.id}/download`,
});

const documentsForOwner = (ownerId) => db.prepare("SELECT id,owner_id,lawyer_id,question_id,consultation_id,kind,file_name,mime_type,size_bytes,status,created_at FROM documents WHERE owner_id=? ORDER BY created_at DESC").all(ownerId).map(publicDocument);
const documentsForLawyer = (lawyer) => db.prepare(`
  SELECT DISTINCT d.id,d.owner_id,d.lawyer_id,d.question_id,d.consultation_id,d.kind,d.file_name,d.mime_type,d.size_bytes,d.status,d.created_at
  FROM documents d
  WHERE d.owner_id=? OR (d.question_id IS NULL AND d.consultation_id IS NULL AND d.lawyer_id=?)
    OR EXISTS(SELECT 1 FROM consultations c WHERE c.id=d.consultation_id AND c.lawyer_id=?)
    OR EXISTS(SELECT 1 FROM question_assignments qa WHERE qa.question_id=d.question_id AND qa.lawyer_id=? AND qa.status IN ('assigned','answered'))
  ORDER BY d.created_at DESC
`).all(lawyer.user_id, lawyer.id, lawyer.id, lawyer.id).map(publicDocument);

const mayAccessDocument = (user, document) => {
  if (!user || !document) return false;
  if (document.owner_id === user.id) return true;
  if (user.role === "admin") return hasAdminPermission(user, "documents.manage");
  if (user.role !== "lawyer") return false;
  const lawyer = lawyerForUser(user.id);
  if (!lawyer) return false;
  if (document.consultation_id) return Boolean(db.prepare("SELECT 1 FROM consultations WHERE id=? AND lawyer_id=?").get(document.consultation_id, lawyer.id));
  if (document.question_id) return Boolean(db.prepare("SELECT 1 FROM question_assignments WHERE question_id=? AND lawyer_id=? AND status IN ('assigned','answered')").get(document.question_id, lawyer.id));
  return document.lawyer_id === lawyer.id;
};

const safeDiskPath = (storedPath) => {
  const diskPath = resolve(String(storedPath));
  const relativePath = relative(uploadsDirectory, diskPath);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) return null;
  return diskPath;
};

const ensureConversation = (consultation) => {
  if (!consultation?.lawyer_id) return null;
  db.prepare("INSERT OR IGNORE INTO conversations(consultation_id,client_id,lawyer_id,status) VALUES(?,?,?,?)").run(
    consultation.id,
    consultation.client_id,
    consultation.lawyer_id,
    consultation.status === "completed" ? "closed" : "open",
  );
  return db.prepare("SELECT * FROM conversations WHERE consultation_id=?").get(consultation.id);
};

const conversationPayloads = (role, id) => {
  const rows = role === "client"
    ? db.prepare("SELECT cv.*,c.topic,c.type consultation_type,c.status consultation_status,u.first_name||' '||u.last_name lawyer_name FROM conversations cv JOIN consultations c ON c.id=cv.consultation_id JOIN lawyers l ON l.id=cv.lawyer_id JOIN users u ON u.id=l.user_id WHERE cv.client_id=? ORDER BY cv.created_at DESC").all(id)
    : db.prepare("SELECT cv.*,c.topic,c.type consultation_type,c.status consultation_status,u.first_name||' '||u.last_name client_name FROM conversations cv JOIN consultations c ON c.id=cv.consultation_id JOIN users u ON u.id=cv.client_id WHERE cv.lawyer_id=? ORDER BY cv.created_at DESC").all(id);
  const messages = db.prepare("SELECT cm.id,cm.conversation_id,cm.sender_id,cm.body,cm.created_at,u.first_name||' '||u.last_name sender_name,u.role sender_role FROM chat_messages cm JOIN users u ON u.id=cm.sender_id WHERE cm.conversation_id=? ORDER BY cm.created_at");
  return rows.map((row) => ({ ...row, messages: messages.all(row.id) }));
};

const recomputeLawyerRating = (lawyerId) => {
  const rating = db.prepare("SELECT ROUND(AVG(rating),1) rating FROM reviews WHERE lawyer_id=? AND status='approved'").get(lawyerId)?.rating;
  db.prepare("UPDATE lawyers SET rating=? WHERE id=?").run(rating ?? 0, lawyerId);
};

const releaseBookedSlot = (consultation) => {
  if (consultation?.slot_id) db.prepare("UPDATE appointment_slots SET status='available' WHERE id=? AND status='booked'").run(consultation.slot_id);
};

const markRefundPending = (consultationId) => {
  db.prepare("UPDATE orders SET status='refund_pending' WHERE consultation_id=? AND status='paid'").run(consultationId);
  db.prepare("UPDATE consultations SET payment_status='refund_pending' WHERE id=? AND payment_status='simulated_paid'").run(consultationId);
};

const checkoutDetails = (trackingCode) => {
  const row = db.prepare(`SELECT o.id order_id,o.client_id,o.type order_type,o.amount,o.status order_status,
    o.tracking_code,o.paid_at,o.created_at order_created_at,c.id consultation_id,c.lawyer_id,
    c.type consultation_type,c.topic,c.scheduled_at,c.payment_status,c.status consultation_status,
    u.first_name||' '||u.last_name lawyer_name
    FROM orders o
    JOIN consultations c ON c.id=o.consultation_id
    LEFT JOIN lawyers l ON l.id=c.lawyer_id
    LEFT JOIN users u ON u.id=l.user_id
    WHERE o.tracking_code=?`).get(trackingCode);
  if (!row) return null;
  return {
    ownerId: row.client_id,
    order: {
      id: row.order_id,
      type: row.order_type,
      amount: row.amount,
      status: row.order_status,
      trackingCode: row.tracking_code,
      paidAt: row.paid_at,
      createdAt: row.order_created_at,
    },
    consultation: {
      id: row.consultation_id,
      lawyerId: row.lawyer_id,
      lawyerName: row.lawyer_name,
      type: row.consultation_type,
      topic: row.topic,
      scheduledAt: row.scheduled_at,
      paymentStatus: row.payment_status,
      status: row.consultation_status,
    },
  };
};

const publicCheckoutDetails = (checkout) => ({
  order: checkout.order,
  consultation: checkout.consultation,
});

const publicBootstrap = () => {
  const lawyers = db.prepare(`
    SELECT l.id,l.license_number,l.specialties,l.bio,l.phone_price,l.text_price,l.in_person_price,l.rating,l.verified,l.featured,l.online,l.in_person_enabled,
      u.first_name||' '||u.last_name name,u.city,u.province,u.created_at joined_at,u.created_at created_at,
      CASE WHEN l.online=1 THEN 'کمتر از ۱ ساعت' ELSE 'حداکثر ۴ ساعت' END response_time,
      (SELECT COUNT(*) FROM consultations c WHERE c.lawyer_id=l.id AND c.status='completed') consultations_count,
      (SELECT COUNT(*) FROM answers a WHERE a.lawyer_id=l.id) answers_count,
      (SELECT COUNT(*) FROM reviews r WHERE r.lawyer_id=l.id AND r.status='approved') reviews_count
    FROM lawyers l JOIN users u ON u.id=l.user_id
    WHERE l.verified=1 AND u.status='active'
    ORDER BY l.featured DESC,l.rating DESC
  `).all();
  const slots = db.prepare("SELECT id,lawyer_id,starts_at,ends_at,consultation_type,status FROM appointment_slots WHERE status='available' AND datetime(starts_at)>datetime('now') ORDER BY starts_at").all();
  const publicLawyers = lawyers.map((lawyer) => ({ ...lawyer, available_slots: slots.filter((slot) => slot.lawyer_id === lawyer.id) }));
  const questionRows = db.prepare(`
    SELECT q.id,q.topic,q.body,q.kind,q.status,q.urgent,q.created_at
    FROM questions q
    WHERE q.publish_allowed=1 AND EXISTS(SELECT 1 FROM answers a WHERE a.question_id=q.id AND a.published=1)
    ORDER BY q.created_at DESC LIMIT 20
  `).all();
  const publicAnswers = db.prepare("SELECT a.id,a.question_id,a.lawyer_id,a.body,a.created_at,u.first_name||' '||u.last_name lawyer_name FROM answers a JOIN lawyers l ON l.id=a.lawyer_id JOIN users u ON u.id=l.user_id WHERE a.question_id=? AND a.published=1 ORDER BY a.created_at");
  const questions = questionRows.map((question) => {
    const answers = publicAnswers.all(question.id);
    return { ...question, answers, answer: answers[0]?.body ?? null, lawyer_name: answers[0]?.lawyer_name ?? null };
  });
  const settingPlaceholders = [...publicSettingNames].map(() => "?").join(",");
  const settings = Object.fromEntries(db.prepare(`SELECT key,value FROM settings WHERE key IN (${settingPlaceholders})`).all(...publicSettingNames).map((item) => [item.key, item.value]));
  return {
    lawyers: publicLawyers,
    articles: db.prepare("SELECT id,slug,title,excerpt,body,category,author,published_at,created_at FROM articles WHERE status='published' ORDER BY published_at DESC").all(),
    questions,
    services: db.prepare("SELECT id,title,description,icon,sort_order FROM services WHERE active=1 ORDER BY sort_order,id").all(),
    faqs: db.prepare("SELECT id,category,question,answer,sort_order FROM faqs WHERE active=1 ORDER BY sort_order,id").all(),
    reviews: db.prepare("SELECT r.id,r.lawyer_id,r.consultation_type,r.body,r.rating,r.created_at,u.first_name||' '||substr(u.last_name,1,1)||'.' client_name,lu.first_name||' '||lu.last_name lawyer_name FROM reviews r JOIN users u ON u.id=r.client_id JOIN lawyers l ON l.id=r.lawyer_id JOIN users lu ON lu.id=l.user_id WHERE r.status='approved' ORDER BY r.created_at DESC LIMIT 20").all(),
    settings,
  };
};

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, null);
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, database: dbPath });
    if (req.method === "GET" && url.pathname === "/api/bootstrap") return json(res, 200, publicBootstrap());

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password ?? "");
      const user = username.length <= 80 ? db.prepare("SELECT * FROM users WHERE username=? AND status='active'").get(username) : null;
      if (!user || !verifyPassword(password, user.password_hash)) return json(res, 401, { error: "نام کاربری یا رمز عبور نادرست است" });
      db.prepare("DELETE FROM sessions WHERE datetime(expires_at)<=datetime('now')").run();
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)").run(token, user.id, expiresAt);
      return json(res, 200, { token, user: { id: user.id, role: user.role, name: `${user.first_name} ${user.last_name}` } });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const token = bearerToken(req);
      if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password ?? "");
      const firstName = validText(body.firstName, 1, 80);
      const lastName = validText(body.lastName, 1, 80);
      const email = cleanText(body.email).toLowerCase();
      const phone = cleanText(body.phone);
      const role = body.role === "lawyer" ? "lawyer" : "client";
      if (!/^[\p{L}\p{N}._-]{3,40}$/u.test(username)) return json(res, 400, { error: "نام کاربری باید ۳ تا ۴۰ نویسه و بدون فاصله باشد" });
      if (password.length < 8 || password.length > 128) return json(res, 400, { error: "رمز عبور باید بین ۸ تا ۱۲۸ نویسه باشد" });
      if (!firstName || !lastName) return json(res, 400, { error: "نام و نام خانوادگی معتبر لازم است" });
      if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "ایمیل معتبر نیست" });
      if (!/^[+\d\s()-]{7,24}$/.test(phone)) return json(res, 400, { error: "شماره تماس معتبر نیست" });
      const province = validText(body.province, 0, 80) ?? "";
      const city = validText(body.city, 0, 80) ?? "";
      const licenseNumber = role === "lawyer" ? validText(body.licenseNumber, 2, 80) : null;
      const specialty = role === "lawyer" ? validText(body.specialty, 2, 300) : null;
      if (role === "lawyer" && (!licenseNumber || !specialty)) return json(res, 400, { error: "تخصص و شماره پروانه برای ثبت‌نام وکیل لازم است" });
      if (db.prepare("SELECT 1 FROM users WHERE username=? OR lower(email)=lower(?)").get(username, email)) return json(res, 409, { error: "نام کاربری یا ایمیل قبلاً ثبت شده است" });
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare("INSERT INTO users(username,password_hash,role,first_name,last_name,email,phone,province,city,status) VALUES(?,?,?,?,?,?,?,?,?,'active')").run(username, hashPassword(password), role, firstName, lastName, email, phone, province, city);
        if (role === "lawyer") {
          const defaultPhone = Number(db.prepare("SELECT value FROM settings WHERE key='default_phone_price'").get()?.value || 480000);
          db.prepare("INSERT INTO lawyers(user_id,license_number,specialties,bio,phone_price,text_price,verified,in_person_enabled) VALUES(?,?,?,?,?,0,0,0)").run(result.lastInsertRowid, licenseNumber, specialty, "پروفایل در انتظار تکمیل و تأیید مدیر", defaultPhone);
        }
        db.exec("COMMIT");
        return json(res, 201, { ok: true, requiresVerification: role === "lawyer" });
      } catch (error) {
        db.exec("ROLLBACK");
        if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "نام کاربری یا ایمیل قبلاً ثبت شده است" });
        throw error;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const user = currentUser(req);
      return user ? json(res, 200, { user: { ...user, name: `${user.first_name} ${user.last_name}` } }) : json(res, 401, { error: "ورود لازم است" });
    }

    if (req.method === "POST" && url.pathname === "/api/profile") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "برای ویرایش پروفایل ابتدا وارد شوید" });
      if (!["client", "lawyer"].includes(user.role)) return json(res, 403, { error: "این پروفایل از این مسیر قابل ویرایش نیست" });
      const value = (camel, snake, current) => Object.hasOwn(body, camel) ? body[camel] : Object.hasOwn(body, snake) ? body[snake] : current;
      const firstName = validText(value("firstName", "first_name", user.first_name), 1, 80);
      const lastName = validText(value("lastName", "last_name", user.last_name), 1, 80);
      const email = cleanText(value("email", "email", user.email)).toLowerCase();
      const phone = cleanText(value("phone", "phone", user.phone));
      const province = cleanText(value("province", "province", user.province ?? ""));
      const city = cleanText(value("city", "city", user.city ?? ""));
      if (!firstName || !lastName) return json(res, 400, { error: "نام و نام خانوادگی معتبر لازم است" });
      if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "ایمیل معتبر نیست" });
      if (!/^[+\d\s()-]{7,24}$/.test(phone)) return json(res, 400, { error: "شماره تماس معتبر نیست" });
      if (province.length > 80 || city.length > 80) return json(res, 400, { error: "نام استان یا شهر بیش از حد طولانی است" });
      const duplicateEmail = db.prepare("SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?").get(email, user.id);
      if (duplicateEmail) return json(res, 409, { error: "این ایمیل قبلاً ثبت شده است" });
      let lawyer = null;
      let lawyerUpdate = null;
      if (user.role === "lawyer") {
        lawyer = lawyerForUser(user.id);
        if (!lawyer) return json(res, 404, { error: "پروفایل وکیل پیدا نشد" });
        const licenseNumber = validText(value("licenseNumber", "license_number", lawyer.license_number), 2, 80);
        const specialties = validText(value("specialties", "specialties", value("specialty", "specialty", lawyer.specialties)), 2, 300);
        const bio = validText(value("bio", "bio", lawyer.bio), 10, 4000);
        const phonePrice = Number(value("phonePrice", "phone_price", lawyer.phone_price));
        const rawInPerson = value("inPersonPrice", "in_person_price", lawyer.in_person_price);
        const inPersonPrice = rawInPerson === null || rawInPerson === "" ? null : Number(rawInPerson);
        if (!licenseNumber || !specialties || !bio) return json(res, 400, { error: "اطلاعات تخصصی پروفایل کامل یا معتبر نیست" });
        if (!Number.isSafeInteger(phonePrice) || phonePrice <= 0 || phonePrice > 100000000) return json(res, 400, { error: "تعرفه تلفنی معتبر نیست" });
        if (inPersonPrice !== null && (!Number.isSafeInteger(inPersonPrice) || inPersonPrice <= 0 || inPersonPrice > 100000000)) return json(res, 400, { error: "تعرفه حضوری معتبر نیست" });
        lawyerUpdate = { licenseNumber, specialties, bio, phonePrice, inPersonPrice, licenseChanged: licenseNumber !== lawyer.license_number };
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE users SET first_name=?,last_name=?,email=?,phone=?,province=?,city=? WHERE id=?").run(firstName, lastName, email, phone, province, city, user.id);
        if (lawyerUpdate) {
          db.prepare(`UPDATE lawyers SET license_number=?,specialties=?,bio=?,phone_price=?,text_price=0,in_person_price=?,
            verified=CASE WHEN ? THEN 0 ELSE verified END,online=CASE WHEN ? THEN 0 ELSE online END,in_person_enabled=CASE WHEN ? THEN 0 ELSE in_person_enabled END
            WHERE user_id=?`).run(lawyerUpdate.licenseNumber, lawyerUpdate.specialties, lawyerUpdate.bio, lawyerUpdate.phonePrice, lawyerUpdate.inPersonPrice, lawyerUpdate.licenseChanged ? 1 : 0, lawyerUpdate.licenseChanged ? 1 : 0, lawyerUpdate.licenseChanged ? 1 : 0, user.id);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "این ایمیل قبلاً ثبت شده است" });
        throw error;
      }
      const account = accountFor(user.id);
      const profile = user.role === "lawyer" ? db.prepare("SELECT l.*,u.first_name,u.last_name,u.email,u.phone,u.province,u.city FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.user_id=?").get(user.id) : account;
      return json(res, 200, { ok: true, account, profile, verificationReset: Boolean(lawyerUpdate?.licenseChanged) });
    }

    if (req.method === "POST" && url.pathname === "/api/documents") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "برای بارگذاری مدرک ابتدا وارد شوید" });
      if (!["client", "lawyer"].includes(user.role)) return json(res, 403, { error: "بارگذاری مدرک از این حساب مجاز نیست" });
      const { file, fields } = await parseMultipart(req);
      const originalName = String(file.fileName).split(/[\\/]/).pop()?.trim() || "";
      if (!originalName || originalName.length > 180 || /[\u0000-\u001f\u007f]/.test(originalName) || basename(originalName) !== originalName) return json(res, 400, { error: "نام فایل معتبر نیست" });
      const { mimeType, extension } = inspectUpload(file);
      const requestedKind = cleanText(fields.kind || "general");
      const kind = /^[\p{L}\p{N}_-]{1,50}$/u.test(requestedKind) ? requestedKind : "general";
      const questionId = fields.questionId || fields.question_id ? validId(fields.questionId || fields.question_id) : null;
      const consultationId = fields.consultationId || fields.consultation_id ? validId(fields.consultationId || fields.consultation_id) : null;
      if ((fields.questionId || fields.question_id) && !questionId || (fields.consultationId || fields.consultation_id) && !consultationId) return json(res, 400, { error: "شناسه پرونده معتبر نیست" });
      if (questionId && consultationId) return json(res, 400, { error: "هر مدرک فقط به یک پرسش یا مشاوره متصل می‌شود" });
      const ownLawyer = user.role === "lawyer" ? lawyerForUser(user.id) : null;
      if (user.role === "lawyer" && !ownLawyer) return json(res, 404, { error: "پروفایل وکیل پیدا نشد" });
      let linkedLawyerId = ownLawyer?.id ?? null;
      if (consultationId) {
        const consultation = db.prepare("SELECT * FROM consultations WHERE id=?").get(consultationId);
        const participant = consultation && (consultation.client_id === user.id || ownLawyer?.id === consultation.lawyer_id);
        if (!participant) return json(res, 403, { error: "به این مشاوره دسترسی ندارید" });
        linkedLawyerId = consultation.lawyer_id;
      }
      if (questionId) {
        const question = db.prepare("SELECT * FROM questions WHERE id=?").get(questionId);
        const assigned = ownLawyer && db.prepare("SELECT 1 FROM question_assignments WHERE question_id=? AND lawyer_id=? AND status IN ('assigned','answered')").get(questionId, ownLawyer.id);
        if (!question || question.client_id !== user.id && question.lawyer_id !== ownLawyer?.id && !assigned) return json(res, 403, { error: "به این پرسش دسترسی ندارید" });
        linkedLawyerId = question.lawyer_id ?? linkedLawyerId;
      }
      const storedName = `${randomBytes(24).toString("hex")}${extension}`;
      const diskPath = resolve(uploadsDirectory, storedName);
      if (!safeDiskPath(`data/uploads/${storedName}`)) return json(res, 400, { error: "مسیر فایل معتبر نیست" });
      writeFileSync(diskPath, file.buffer, { flag: "wx", mode: 0o600 });
      try {
        const result = db.prepare("INSERT INTO documents(owner_id,lawyer_id,question_id,consultation_id,kind,file_name,path,mime_type,size_bytes,status) VALUES(?,?,?,?,?,?,?,?,?,'pending')").run(user.id, linkedLawyerId, questionId, consultationId, kind, originalName, `data/uploads/${storedName}`, mimeType, file.buffer.length);
        const document = db.prepare("SELECT * FROM documents WHERE id=?").get(result.lastInsertRowid);
        return json(res, 201, { ok: true, document: publicDocument(document) });
      } catch (error) {
        try { unlinkSync(diskPath); } catch {}
        throw error;
      }
    }

    const documentDownload = /^\/api\/documents\/(\d+)\/download$/.exec(url.pathname);
    if (req.method === "GET" && documentDownload) {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "ورود لازم است" });
      const document = db.prepare("SELECT * FROM documents WHERE id=?").get(Number(documentDownload[1]));
      if (!document || !mayAccessDocument(user, document)) return json(res, 404, { error: "مدرک پیدا نشد" });
      const diskPath = safeDiskPath(document.path);
      if (!diskPath || !existsSync(diskPath)) return json(res, 404, { error: "فایل مدرک پیدا نشد" });
      const contents = readFileSync(diskPath);
      res.writeHead(200, {
        "Content-Type": document.mime_type,
        "Content-Length": String(contents.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.file_name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(contents);
    }

    if (req.method === "POST" && url.pathname === "/api/questions") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "برای ثبت پرسش ابتدا وارد حساب شوید" });
      if (user.role !== "client") return json(res, 403, { error: "ثبت پرسش از حساب موکل انجام می‌شود" });
      if (db.prepare("SELECT value FROM settings WHERE key='questions_enabled'").get()?.value === "0") return json(res, 503, { error: "ثبت پرسش رایگان موقتاً غیرفعال است" });
      const topic = validText(body.topic, 2, 160);
      const questionBody = validText(body.body, 20, 5000);
      if (!topic || !questionBody) return json(res, 400, { error: "موضوع و ۲۰ تا ۵۰۰۰ نویسه توضیح لازم است" });
      const lawyerId = body.lawyerId === null || body.lawyerId === undefined || body.lawyerId === "" ? null : validId(body.lawyerId);
      if (body.lawyerId != null && body.lawyerId !== "" && !lawyerId) return json(res, 400, { error: "شناسه وکیل معتبر نیست" });
      if (lawyerId && !db.prepare("SELECT 1 FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.id=? AND l.verified=1 AND u.status='active'").get(lawyerId)) return json(res, 400, { error: "وکیل انتخاب‌شده معتبر یا تأییدشده نیست" });
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare("INSERT INTO questions(client_id,lawyer_id,topic,body,kind,status,publish_allowed,urgent) VALUES(?,?,?,?,?,?,?,?)").run(user.id, lawyerId, topic, questionBody, lawyerId ? "direct" : "public", lawyerId ? "assigned" : "pending_assignment", body.publishAllowed === true ? 1 : 0, body.urgent === true ? 1 : 0);
        if (lawyerId) db.prepare("INSERT INTO question_assignments(question_id,lawyer_id,status) VALUES(?,?,'assigned')").run(result.lastInsertRowid, lawyerId);
        db.exec("COMMIT");
        return json(res, 201, { ok: true, id: Number(result.lastInsertRowid), status: lawyerId ? "assigned" : "pending_assignment" });
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/consultations") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "برای ثبت مشاوره ابتدا وارد حساب شوید" });
      if (user.role !== "client") return json(res, 403, { error: "ثبت مشاوره از حساب موکل انجام می‌شود" });
      const type = cleanText(body.type);
      const topic = validText(body.topic, 2, 500);
      if (!["phone", "in_person"].includes(type)) return json(res, 400, { error: "فقط مشاوره تلفنی یا حضوری قابل پرداخت است؛ پرسش متنی رایگان است" });
      if (!topic) return json(res, 400, { error: "موضوع مشاوره معتبر لازم است" });
      if (type === "in_person" && db.prepare("SELECT value FROM settings WHERE key='global_in_person_enabled'").get()?.value === "0") return json(res, 503, { error: "مشاوره حضوری موقتاً غیرفعال است" });
      let lawyerId = body.lawyerId == null || body.lawyerId === "" ? null : validId(body.lawyerId);
      const slotId = body.slotId == null || body.slotId === "" ? null : validId(body.slotId);
      if (body.lawyerId != null && body.lawyerId !== "" && !lawyerId || body.slotId != null && body.slotId !== "" && !slotId) return json(res, 400, { error: "شناسه وکیل یا زمان انتخابی معتبر نیست" });
      if (type === "in_person" && (!lawyerId || !slotId)) return json(res, 400, { error: "برای مشاوره حضوری انتخاب وکیل و یک زمان آزاد الزامی است" });
      if (slotId && !lawyerId) return json(res, 400, { error: "زمان آزاد باید همراه وکیل انتخاب شود" });
      let lawyer = lawyerId ? db.prepare("SELECT l.* FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.id=? AND l.verified=1 AND u.status='active'").get(lawyerId) : null;
      if (lawyerId && !lawyer) return json(res, 400, { error: "وکیل انتخاب‌شده معتبر یا تأییدشده نیست" });
      if (type === "in_person" && (!lawyer.in_person_enabled || !lawyer.in_person_price)) return json(res, 400, { error: "مشاوره حضوری برای این وکیل فعال نیست" });
      let scheduledAt = validIsoFuture(body.scheduledAt, true);
      if (scheduledAt === undefined) return json(res, 400, { error: "زمان مشاوره باید تاریخ ISO معتبر و در آینده باشد" });
      const defaultPrice = Number(db.prepare("SELECT value FROM settings WHERE key=?").get(type === "phone" ? "default_phone_price" : "default_in_person_price")?.value || 0);
      const amount = Number(lawyer ? type === "phone" ? lawyer.phone_price : lawyer.in_person_price : defaultPrice);
      const commissionRate = Number(db.prepare("SELECT value FROM settings WHERE key='site_commission'").get()?.value || 0);
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000 || !Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100) return json(res, 409, { error: "تعرفه معتبر برای این مشاوره ثبت نشده است" });
      const commissionAmount = Math.round(amount * commissionRate / 100);
      const trackingCode = `DR-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
      const deferPayment = body.deferPayment === true;
      const status = deferPayment ? "pending_payment" : lawyer ? "registered" : "pending_assignment";
      const paymentStatus = deferPayment ? "pending" : "simulated_paid";
      const orderStatus = deferPayment ? "pending" : "paid";
      let consultationId;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (slotId) {
          const slot = db.prepare("SELECT * FROM appointment_slots WHERE id=? AND lawyer_id=? AND consultation_type=? AND status='available' AND datetime(starts_at)>datetime('now')").get(slotId, lawyerId, type);
          if (!slot) throw new ApiError(409, "زمان انتخاب‌شده دیگر در دسترس نیست");
          scheduledAt = new Date(slot.starts_at).toISOString();
          const consumed = db.prepare("UPDATE appointment_slots SET status='booked' WHERE id=? AND status='available'").run(slotId);
          if (!consumed.changes) throw new ApiError(409, "زمان انتخاب‌شده دیگر در دسترس نیست");
        }
        const result = db.prepare("INSERT INTO consultations(client_id,lawyer_id,slot_id,type,topic,scheduled_at,amount,payment_status,status) VALUES(?,?,?,?,?,?,?,?,?)").run(user.id, lawyerId, slotId, type, topic, scheduledAt, amount, paymentStatus, status);
        consultationId = Number(result.lastInsertRowid);
        db.prepare("INSERT INTO orders(client_id,consultation_id,type,amount,commission_rate,commission_amount,status,tracking_code,paid_at) VALUES(?,?,?,?,?,?,?,?,CASE WHEN ?='paid' THEN CURRENT_TIMESTAMP ELSE NULL END)").run(user.id, consultationId, type, amount, commissionRate, commissionAmount, orderStatus, trackingCode, orderStatus);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(res, 201, {
        ok: true,
        id: consultationId,
        amount,
        commissionRate,
        status,
        trackingCode,
        paymentStatus,
        paymentRequired: deferPayment,
        checkoutPath: deferPayment ? `/api/checkout/${trackingCode}` : null,
        scheduledAt,
      });
    }

    const checkoutRoute = /^\/api\/checkout\/(DR-[A-Z0-9]+-[A-F0-9]+)(?:\/(pay|cancel))?$/.exec(url.pathname);
    if (checkoutRoute) {
      const [, trackingCode, checkoutAction] = checkoutRoute;
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "ورود به حساب کاربری لازم است" });

      if (req.method === "GET" && !checkoutAction) {
        const checkout = checkoutDetails(trackingCode);
        if (!checkout) return json(res, 404, { error: "سفارش پیدا نشد" });
        if (user.role !== "admin" && checkout.ownerId !== user.id) return json(res, 403, { error: "به این سفارش دسترسی ندارید" });
        return json(res, 200, { ok: true, ...publicCheckoutDetails(checkout) });
      }

      if (req.method === "POST" && checkoutAction === "pay") {
        if (user.role !== "client") return json(res, 403, { error: "پرداخت فقط توسط صاحب سفارش انجام می‌شود" });
        let result;
        let idempotent = false;
        db.exec("BEGIN IMMEDIATE");
        try {
          const checkout = checkoutDetails(trackingCode);
          if (!checkout) throw new ApiError(404, "سفارش پیدا نشد");
          if (checkout.ownerId !== user.id) throw new ApiError(403, "به این سفارش دسترسی ندارید");
          if (checkout.order.status === "paid" && checkout.consultation.paymentStatus === "simulated_paid") {
            result = checkout;
            idempotent = true;
          } else {
            if (checkout.order.status !== "pending" || checkout.consultation.status !== "pending_payment" || checkout.consultation.paymentStatus !== "pending") {
              throw new ApiError(409, "این سفارش در وضعیت قابل پرداخت نیست");
            }
            const nextStatus = checkout.consultation.lawyerId ? "registered" : "pending_assignment";
            const paid = db.prepare("UPDATE orders SET status='paid',paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(checkout.order.id);
            const confirmed = db.prepare("UPDATE consultations SET payment_status='simulated_paid',status=? WHERE id=? AND status='pending_payment' AND payment_status='pending'").run(nextStatus, checkout.consultation.id);
            if (!paid.changes || !confirmed.changes) throw new ApiError(409, "وضعیت پرداخت هم‌زمان تغییر کرده است");
            result = checkoutDetails(trackingCode);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return json(res, 200, { ok: true, idempotent, ...publicCheckoutDetails(result) });
      }

      if (req.method === "POST" && checkoutAction === "cancel") {
        if (user.role !== "client") return json(res, 403, { error: "لغو پرداخت فقط توسط صاحب سفارش انجام می‌شود" });
        let result;
        let idempotent = false;
        db.exec("BEGIN IMMEDIATE");
        try {
          const checkout = checkoutDetails(trackingCode);
          if (!checkout) throw new ApiError(404, "سفارش پیدا نشد");
          if (checkout.ownerId !== user.id) throw new ApiError(403, "به این سفارش دسترسی ندارید");
          if (checkout.order.status === "cancelled" && checkout.consultation.status === "cancelled") {
            result = checkout;
            idempotent = true;
          } else {
            if (checkout.order.status !== "pending" || checkout.consultation.status !== "pending_payment" || checkout.consultation.paymentStatus !== "pending") {
              throw new ApiError(409, "این سفارش در وضعیت قابل لغو نیست");
            }
            const slotId = db.prepare("SELECT slot_id FROM consultations WHERE id=?").get(checkout.consultation.id)?.slot_id;
            const cancelledOrder = db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(checkout.order.id);
            const cancelledConsultation = db.prepare("UPDATE consultations SET slot_id=NULL,payment_status='cancelled',status='cancelled' WHERE id=? AND status='pending_payment' AND payment_status='pending'").run(checkout.consultation.id);
            if (!cancelledOrder.changes || !cancelledConsultation.changes) throw new ApiError(409, "وضعیت پرداخت هم‌زمان تغییر کرده است");
            releaseBookedSlot({ slot_id: slotId });
            result = checkoutDetails(trackingCode);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return json(res, 200, { ok: true, idempotent, ...publicCheckoutDetails(result) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/consultation/action") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "ورود لازم است" });
      const consultationId = validId(body.id ?? body.consultationId);
      if (!consultationId) return json(res, 400, { error: "شناسه مشاوره معتبر نیست" });
      const consultation = db.prepare("SELECT * FROM consultations WHERE id=?").get(consultationId);
      if (!consultation) return json(res, 404, { error: "مشاوره پیدا نشد" });
      const action = cleanText(body.action);
      let nextStatus = null;
      if (user.role === "client") {
        if (consultation.client_id !== user.id) return json(res, 403, { error: "به این مشاوره دسترسی ندارید" });
        if (action !== "cancel") return json(res, 403, { error: "این عملیات برای موکل مجاز نیست" });
        if (!["pending_assignment", "registered", "confirmed"].includes(consultation.status)) return json(res, 409, { error: "این مشاوره در وضعیت فعلی قابل لغو نیست" });
        nextStatus = "cancelled";
      } else if (user.role === "lawyer") {
        const lawyer = lawyerForUser(user.id);
        if (!lawyer || !lawyer.verified || consultation.lawyer_id !== lawyer.id) return json(res, 403, { error: "این مشاوره به شما ارجاع نشده است" });
        const lawyerTransitions = {
          accept: { from: ["registered"], to: "confirmed" },
          reject: { from: ["registered"], to: "rejected" },
          start: { from: ["confirmed"], to: "in_progress" },
          complete: { from: ["confirmed", "in_progress"], to: "completed" },
        };
        const transition = lawyerTransitions[action];
        if (!transition) return json(res, 400, { error: "عملیات مشاوره ناشناخته است" });
        if (!transition.from.includes(consultation.status)) return json(res, 409, { error: "تغییر وضعیت درخواست‌شده مجاز نیست" });
        nextStatus = transition.to;
      } else if (user.role === "admin") {
        if (!hasAdminPermission(user, "consultations.manage")) return json(res, 403, { error: "مجوز مدیریت مشاوره‌ها را ندارید" });
        if (action !== "set-status") return json(res, 400, { error: "عملیات مدیر ناشناخته است" });
        const requested = cleanText(body.status);
        const transitions = {
          pending_assignment: ["registered", "cancelled"],
          registered: ["confirmed", "rejected", "cancelled"],
          confirmed: ["in_progress", "completed", "cancelled"],
          in_progress: ["completed"],
          completed: [], rejected: [], cancelled: [],
        };
        if (!transitions[consultation.status]?.includes(requested)) return json(res, 409, { error: "تغییر وضعیت درخواست‌شده مجاز نیست" });
        if (["registered", "confirmed", "in_progress", "completed"].includes(requested) && !consultation.lawyer_id) return json(res, 409, { error: "پیش از این وضعیت باید وکیل تخصیص داده شود" });
        nextStatus = requested;
      } else {
        return json(res, 403, { error: "دسترسی مجاز نیست" });
      }

      db.exec("BEGIN IMMEDIATE");
      try {
        const completedAt = nextStatus === "completed" ? new Date().toISOString() : null;
        const changed = db.prepare("UPDATE consultations SET status=?,completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END WHERE id=? AND status=?").run(nextStatus, nextStatus, completedAt, consultation.id, consultation.status);
        if (!changed.changes) throw new ApiError(409, "وضعیت مشاوره هم‌زمان تغییر کرده است");
        if (["cancelled", "rejected"].includes(nextStatus)) {
          releaseBookedSlot(consultation);
          markRefundPending(consultation.id);
          db.prepare("UPDATE conversations SET status='closed' WHERE consultation_id=?").run(consultation.id);
        }
        if (nextStatus === "completed") db.prepare("UPDATE conversations SET status='closed' WHERE consultation_id=?").run(consultation.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const updated = db.prepare("SELECT * FROM consultations WHERE id=?").get(consultation.id);
      const conversation = ["confirmed", "in_progress", "completed"].includes(nextStatus) ? ensureConversation(updated) : null;
      if (nextStatus === "completed" && conversation) db.prepare("UPDATE conversations SET status='closed' WHERE id=?").run(conversation.id);
      return json(res, 200, { ok: true, consultation: updated, conversation: conversation ? { ...conversation, status: nextStatus === "completed" ? "closed" : conversation.status } : null });
    }

    if (req.method === "POST" && url.pathname === "/api/chat/messages") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user || !["client", "lawyer"].includes(user.role)) return json(res, 401, { error: "ورود موکل یا وکیل لازم است" });
      let conversation = body.conversationId ? db.prepare("SELECT * FROM conversations WHERE id=?").get(validId(body.conversationId)) : null;
      if (!conversation && body.consultationId) {
        const consultation = db.prepare("SELECT * FROM consultations WHERE id=?").get(validId(body.consultationId));
        const ownLawyer = user.role === "lawyer" ? lawyerForUser(user.id) : null;
        const participant = consultation && (consultation.client_id === user.id || consultation.lawyer_id === ownLawyer?.id);
        if (participant && ["confirmed", "in_progress"].includes(consultation.status)) conversation = ensureConversation(consultation);
      }
      if (!conversation) return json(res, 404, { error: "گفت‌وگو پیدا نشد" });
      const ownLawyer = user.role === "lawyer" ? lawyerForUser(user.id) : null;
      if (conversation.client_id !== user.id && conversation.lawyer_id !== ownLawyer?.id) return json(res, 403, { error: "به این گفت‌وگو دسترسی ندارید" });
      const consultation = db.prepare("SELECT status FROM consultations WHERE id=?").get(conversation.consultation_id);
      if (conversation.status !== "open" || !["confirmed", "in_progress"].includes(consultation?.status)) return json(res, 409, { error: "این گفت‌وگو بسته است" });
      const messageBody = validText(body.body, 1, 4000);
      if (!messageBody) return json(res, 400, { error: "متن پیام باید بین ۱ تا ۴۰۰۰ نویسه باشد" });
      const result = db.prepare("INSERT INTO chat_messages(conversation_id,sender_id,body) VALUES(?,?,?)").run(conversation.id, user.id, messageBody);
      const message = db.prepare("SELECT cm.id,cm.conversation_id,cm.sender_id,cm.body,cm.created_at,u.first_name||' '||u.last_name sender_name,u.role sender_role FROM chat_messages cm JOIN users u ON u.id=cm.sender_id WHERE cm.id=?").get(result.lastInsertRowid);
      return json(res, 201, { ok: true, message });
    }

    if (req.method === "POST" && url.pathname === "/api/answers") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (user?.role !== "lawyer") return json(res, 403, { error: "دسترسی وکیل لازم است" });
      const lawyer = db.prepare("SELECT id FROM lawyers WHERE user_id=? AND verified=1").get(user.id);
      if (!lawyer) return json(res, 403, { error: "پروفایل وکیل هنوز تأیید نشده است" });
      const questionId = validId(body.questionId);
      const answerBody = validText(body.body, 10, 6000);
      if (!questionId || !answerBody) return json(res, 400, { error: "شناسه پرسش و پاسخ ۱۰ تا ۶۰۰۰ نویسه‌ای لازم است" });
      const question = db.prepare(`
        SELECT q.id,q.publish_allowed FROM questions q
        WHERE q.id=? AND EXISTS(
          SELECT 1 FROM question_assignments qa WHERE qa.question_id=q.id AND qa.lawyer_id=? AND qa.status='assigned'
        )
      `).get(questionId, lawyer.id);
      if (!question) return json(res, 403, { error: "این پرسش به شما ارجاع نشده یا قبلاً پاسخ داده شده است" });
      if (db.prepare("SELECT 1 FROM answers WHERE question_id=? AND lawyer_id=?").get(questionId, lawyer.id)) return json(res, 409, { error: "پاسخ شما قبلاً برای این پرسش ثبت شده است" });
      let result;
      db.exec("BEGIN IMMEDIATE");
      try {
        result = db.prepare("INSERT INTO answers(question_id,lawyer_id,body,published) VALUES(?,?,?,?)").run(questionId, lawyer.id, answerBody, question.publish_allowed ? 1 : 0);
        db.prepare("UPDATE question_assignments SET status='answered' WHERE question_id=? AND lawyer_id=?").run(questionId, lawyer.id);
        const remaining = db.prepare("SELECT COUNT(*) count FROM question_assignments WHERE question_id=? AND status='assigned'").get(questionId).count;
        db.prepare("UPDATE questions SET status=? WHERE id=?").run(remaining ? "assigned" : "answered", questionId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(res, 201, { ok: true, id: Number(result.lastInsertRowid), public: Boolean(question.publish_allowed) });
    }

    if (req.method === "POST" && url.pathname === "/api/reviews") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "ابتدا وارد شوید" });
      if (user.role !== "client") return json(res, 403, { error: "ثبت نظر فقط از حساب موکل انجام می‌شود" });
      const consultationId = validId(body.consultationId);
      const rating = Number(body.rating);
      const reviewBody = validText(body.body, 10, 2000);
      if (!consultationId || !Number.isSafeInteger(rating) || rating < 1 || rating > 5 || !reviewBody) return json(res, 400, { error: "مشاوره، امتیاز ۱ تا ۵ و متن ۱۰ تا ۲۰۰۰ نویسه‌ای لازم است" });
      const consultation = db.prepare("SELECT * FROM consultations WHERE id=? AND client_id=? AND status='completed' AND lawyer_id IS NOT NULL").get(consultationId, user.id);
      if (!consultation) return json(res, 403, { error: "فقط برای مشاوره تکمیل‌شده خود می‌توانید نظر ثبت کنید" });
      if (body.lawyerId != null && Number(body.lawyerId) !== consultation.lawyer_id || body.type != null && cleanText(body.type) !== consultation.type) return json(res, 400, { error: "اطلاعات نظر با مشاوره انتخابی تطابق ندارد" });
      if (db.prepare("SELECT 1 FROM reviews WHERE consultation_id=?").get(consultationId)) return json(res, 409, { error: "برای این مشاوره قبلاً نظر ثبت شده است" });
      try {
        const result = db.prepare("INSERT INTO reviews(client_id,lawyer_id,consultation_id,consultation_type,body,rating,status) VALUES(?,?,?,?,?,?,'pending')").run(user.id, consultation.lawyer_id, consultationId, consultation.type, reviewBody, rating);
        return json(res, 201, { ok: true, id: Number(result.lastInsertRowid) });
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "برای این مشاوره قبلاً نظر ثبت شده است" });
        throw error;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/bookmarks") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "ابتدا وارد شوید" });
      if (user.role !== "client") return json(res, 403, { error: "نشان کردن وکیل فقط برای موکل مجاز است" });
      const lawyerId = validId(body.lawyerId);
      if (!lawyerId || !db.prepare("SELECT 1 FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.id=? AND l.verified=1 AND u.status='active'").get(lawyerId)) return json(res, 400, { error: "وکیل معتبر پیدا نشد" });
      const existing = db.prepare("SELECT id FROM bookmarks WHERE client_id=? AND lawyer_id=?").get(user.id, lawyerId);
      if (existing) db.prepare("DELETE FROM bookmarks WHERE id=?").run(existing.id);
      else db.prepare("INSERT INTO bookmarks(client_id,lawyer_id) VALUES(?,?)").run(user.id, lawyerId);
      return json(res, 200, { ok: true, saved: !existing });
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      const body = await readBody(req);
      const user = currentUser(req);
      const name = validText(body.name, 2, 160);
      const phone = cleanText(body.phone);
      const kind = ["support", "complaint", "cooperation", "contact"].includes(cleanText(body.kind)) ? cleanText(body.kind) : "support";
      const subject = validText(body.subject || "پیام سایت", 2, 200);
      const messageBody = validText(body.body, 10, 5000);
      const orderCode = body.orderCode ? validText(body.orderCode, 3, 100) : null;
      if (!name || !/^[+\d\s()-]{7,24}$/.test(phone) || !subject || !messageBody) return json(res, 400, { error: "نام، تلفن، موضوع و متن معتبر لازم است" });
      if (orderCode && user?.role === "client" && !db.prepare("SELECT 1 FROM orders WHERE client_id=? AND tracking_code=?").get(user.id, orderCode)) return json(res, 400, { error: "کد سفارش متعلق به این حساب نیست" });
      const result = db.prepare("INSERT INTO messages(user_id,name,phone,kind,subject,body,order_code,status,updated_at) VALUES(?,?,?,?,?,?,?,'new',CURRENT_TIMESTAMP)").run(user?.id ?? null, name, phone, kind, subject, messageBody, orderCode);
      return json(res, 201, { ok: true, id: Number(result.lastInsertRowid) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats") {
      const user = currentUser(req);
      if (!user || user.role !== "admin") return json(res, 401, { error: "ورود مدیر لازم است" });
      if (!hasAnyAdminPermission(user, ["reports.view", "finance.view"])) return json(res, 403, { error: "مجوز مشاهده گزارش‌ها را ندارید" });
      const stats = {
        users: db.prepare("SELECT COUNT(*) count FROM users WHERE role<>'admin'").get().count,
        lawyers: db.prepare("SELECT COUNT(*) count FROM lawyers").get().count,
        consultations: db.prepare("SELECT COUNT(*) count FROM consultations").get().count,
        questions: db.prepare("SELECT COUNT(*) count FROM questions").get().count,
        revenue: hasAdminPermission(user, "finance.view")
          ? db.prepare("SELECT COALESCE(SUM(amount),0) total FROM orders WHERE status='paid'").get().total
          : null,
      };
      return json(res, 200, { stats });
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "ورود لازم است" });

      if (user.role === "client") {
        const questionRows = db.prepare("SELECT id,lawyer_id,topic,body,kind,status,publish_allowed,urgent,created_at FROM questions WHERE client_id=? ORDER BY created_at DESC").all(user.id);
        const answerStatement = db.prepare("SELECT a.id,a.question_id,a.lawyer_id,a.body,a.published,a.created_at,u.first_name||' '||u.last_name lawyer_name FROM answers a JOIN lawyers l ON l.id=a.lawyer_id JOIN users u ON u.id=l.user_id WHERE a.question_id=? ORDER BY a.created_at");
        const questions = questionRows.map((question) => ({ ...question, answers: answerStatement.all(question.id) }));
        const consultations = db.prepare("SELECT c.*,u.first_name||' '||u.last_name lawyer_name,o.tracking_code,o.status order_status FROM consultations c LEFT JOIN lawyers l ON l.id=c.lawyer_id LEFT JOIN users u ON u.id=l.user_id LEFT JOIN orders o ON o.consultation_id=c.id WHERE c.client_id=? ORDER BY c.created_at DESC").all(user.id);
        const orders = db.prepare("SELECT o.*,c.topic,c.status consultation_status,u.first_name||' '||u.last_name lawyer_name FROM orders o LEFT JOIN consultations c ON c.id=o.consultation_id LEFT JOIN lawyers l ON l.id=c.lawyer_id LEFT JOIN users u ON u.id=l.user_id WHERE o.client_id=? ORDER BY o.created_at DESC").all(user.id);
        const bookmarks = db.prepare("SELECT l.id,l.specialties,l.rating,l.online,l.in_person_enabled,u.first_name||' '||u.last_name name,u.city,b.created_at FROM bookmarks b JOIN lawyers l ON l.id=b.lawyer_id JOIN users u ON u.id=l.user_id WHERE b.client_id=? ORDER BY b.created_at DESC").all(user.id);
        const reviews = db.prepare("SELECT r.*,u.first_name||' '||u.last_name lawyer_name FROM reviews r JOIN lawyers l ON l.id=r.lawyer_id JOIN users u ON u.id=l.user_id WHERE r.client_id=? ORDER BY r.created_at DESC").all(user.id);
        const eligibleReviews = db.prepare("SELECT c.id consultation_id,c.lawyer_id,c.type,c.topic,c.completed_at,u.first_name||' '||u.last_name lawyer_name FROM consultations c JOIN lawyers l ON l.id=c.lawyer_id JOIN users u ON u.id=l.user_id LEFT JOIN reviews r ON r.consultation_id=c.id WHERE c.client_id=? AND c.status='completed' AND r.id IS NULL ORDER BY c.completed_at DESC").all(user.id);
        const messages = db.prepare("SELECT id,name,phone,kind,subject,body,order_code,admin_reply,status,created_at,updated_at FROM messages WHERE user_id=? ORDER BY created_at DESC").all(user.id);
        return json(res, 200, {
          role: "client",
          account: accountFor(user.id),
          profile: accountFor(user.id),
          consultations,
          orders,
          questions,
          bookmarks,
          reviews,
          eligibleReviews,
          documents: documentsForOwner(user.id),
          conversations: conversationPayloads("client", user.id),
          messages,
        });
      }

      if (user.role === "lawyer") {
        const lawyer = lawyerForUser(user.id);
        if (!lawyer) return json(res, 404, { error: "پروفایل وکیل پیدا نشد" });
        const profile = db.prepare("SELECT l.*,u.username,u.first_name,u.last_name,u.email,u.phone,u.province,u.city,u.status,u.created_at FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.id=?").get(lawyer.id);
        const consultations = db.prepare("SELECT c.*,u.first_name||' '||u.last_name client_name,u.phone client_phone,o.tracking_code,o.status order_status FROM consultations c LEFT JOIN users u ON u.id=c.client_id LEFT JOIN orders o ON o.consultation_id=c.id WHERE c.lawyer_id=? ORDER BY c.created_at DESC").all(lawyer.id);
        const questions = db.prepare("SELECT q.id,q.client_id,q.lawyer_id,q.topic,q.body,q.kind,q.status,q.publish_allowed,q.urgent,q.created_at,qa.status assignment_status,qa.assigned_at FROM question_assignments qa JOIN questions q ON q.id=qa.question_id WHERE qa.lawyer_id=? AND qa.status IN ('assigned','answered') ORDER BY q.created_at DESC").all(lawyer.id);
        const slots = db.prepare("SELECT id,lawyer_id,starts_at,ends_at,consultation_type,status FROM appointment_slots WHERE lawyer_id=? ORDER BY starts_at DESC").all(lawyer.id);
        const reviews = db.prepare("SELECT r.*,u.first_name||' '||substr(u.last_name,1,1)||'.' client_name FROM reviews r LEFT JOIN users u ON u.id=r.client_id WHERE r.lawyer_id=? ORDER BY r.created_at DESC").all(lawyer.id);
        const orders = db.prepare("SELECT o.*,c.topic,c.status consultation_status,u.first_name||' '||u.last_name client_name,(o.amount-o.commission_amount) net_amount FROM orders o JOIN consultations c ON c.id=o.consultation_id LEFT JOIN users u ON u.id=c.client_id WHERE c.lawyer_id=? ORDER BY o.created_at DESC").all(lawyer.id);
        return json(res, 200, {
          role: "lawyer",
          account: accountFor(user.id),
          profile,
          consultations,
          questions,
          slots,
          reviews,
          orders,
          documents: documentsForLawyer(lawyer),
          conversations: conversationPayloads("lawyer", lawyer.id),
        });
      }

      if (user.role === "admin") {
        const capabilities = permissionNames.filter((permission) => hasAdminPermission(user, permission));
        const primary = isPrimaryAdmin(user);
        const can = (permission) => capabilities.includes(permission);
        const data = {
          role: "admin",
          account: accountFor(user.id),
          capabilities,
          isPrimaryAdmin: primary,
          stats: {
            users: can("users.manage") || can("reports.view") ? db.prepare("SELECT COUNT(*) count FROM users WHERE role<>'admin'").get().count : null,
            lawyers: can("lawyers.verify") || can("reports.view") ? db.prepare("SELECT COUNT(*) count FROM lawyers").get().count : null,
            consultations: can("consultations.manage") || can("reports.view") ? db.prepare("SELECT COUNT(*) count FROM consultations").get().count : null,
            questions: can("questions.assign") || can("reports.view") ? db.prepare("SELECT COUNT(*) count FROM questions").get().count : null,
            revenue: can("finance.view") ? db.prepare("SELECT COALESCE(SUM(amount),0) total FROM orders WHERE status='paid'").get().total : null,
          },
        };

        if (can("users.manage")) {
          data.users = db.prepare("SELECT id,username,role,first_name,last_name,email,phone,province,city,status,created_at FROM users WHERE role<>'admin' ORDER BY created_at DESC").all();
        }

        if (can("lawyers.verify") || can("questions.assign") || can("consultations.manage")) {
          const lawyerRows = db.prepare("SELECT l.*,u.username,u.first_name,u.last_name,u.first_name||' '||u.last_name name,u.email,u.phone,u.province,u.city,u.status,u.created_at FROM lawyers l JOIN users u ON u.id=l.user_id ORDER BY l.verified ASC,u.created_at DESC").all();
          data.lawyers = can("lawyers.verify")
            ? lawyerRows
            : lawyerRows.map((lawyerRow) => {
                const safeLawyer = { ...lawyerRow };
                delete safeLawyer.email;
                delete safeLawyer.phone;
                delete safeLawyer.license_number;
                delete safeLawyer.bio;
                return safeLawyer;
              });
          if (can("lawyers.verify")) data.pendingLawyers = lawyerRows.filter((lawyerRow) => !lawyerRow.verified);
        }

        if (can("questions.assign") || can("reports.view")) {
          const questionRows = db.prepare("SELECT q.*,u.first_name||' '||u.last_name client_name FROM questions q LEFT JOIN users u ON u.id=q.client_id ORDER BY q.created_at DESC").all();
          const assignmentStatement = db.prepare("SELECT qa.lawyer_id,qa.status,qa.assigned_at,u.first_name||' '||u.last_name lawyer_name FROM question_assignments qa JOIN lawyers l ON l.id=qa.lawyer_id JOIN users u ON u.id=l.user_id WHERE qa.question_id=? ORDER BY qa.assigned_at");
          const answerStatement = db.prepare("SELECT a.id,a.lawyer_id,a.body,a.published,a.created_at,u.first_name||' '||u.last_name lawyer_name FROM answers a JOIN lawyers l ON l.id=a.lawyer_id JOIN users u ON u.id=l.user_id WHERE a.question_id=? ORDER BY a.created_at");
          data.questions = questionRows.map((question) => ({ ...question, assignments: assignmentStatement.all(question.id), answers: answerStatement.all(question.id) }));
          if (can("questions.assign")) data.unassignedQuestions = data.questions.filter((question) => question.status === "pending_assignment");
        }

        if (can("consultations.manage") || can("reports.view")) {
          data.consultations = db.prepare("SELECT c.*,cu.first_name||' '||cu.last_name client_name,lu.first_name||' '||lu.last_name lawyer_name,o.tracking_code,o.status order_status FROM consultations c LEFT JOIN users cu ON cu.id=c.client_id LEFT JOIN lawyers l ON l.id=c.lawyer_id LEFT JOIN users lu ON lu.id=l.user_id LEFT JOIN orders o ON o.consultation_id=c.id ORDER BY c.created_at DESC").all();
          if (can("consultations.manage")) data.pendingConsultations = data.consultations.filter((consultation) => consultation.status === "pending_assignment" || consultation.status === "registered");
        }

        if (can("finance.view") || can("payments.manage") || can("reports.view")) {
          data.orders = db.prepare("SELECT o.*,c.topic,c.status consultation_status,u.first_name||' '||u.last_name client_name,lu.first_name||' '||lu.last_name lawyer_name FROM orders o LEFT JOIN consultations c ON c.id=o.consultation_id LEFT JOIN users u ON u.id=o.client_id LEFT JOIN lawyers l ON l.id=c.lawyer_id LEFT JOIN users lu ON lu.id=l.user_id ORDER BY o.created_at DESC").all();
          if (!can("finance.view") && !can("payments.manage")) {
            data.orders = data.orders.map((order) => {
              const safeOrder = { ...order };
              delete safeOrder.amount;
              delete safeOrder.commission_rate;
              delete safeOrder.commission_amount;
              return safeOrder;
            });
          }
        }

        if (can("reviews.manage") || can("reports.view")) {
          data.reviews = db.prepare("SELECT r.*,u.first_name||' '||u.last_name client_name,lu.first_name||' '||lu.last_name lawyer_name FROM reviews r LEFT JOIN users u ON u.id=r.client_id JOIN lawyers l ON l.id=r.lawyer_id JOIN users lu ON lu.id=l.user_id ORDER BY r.created_at DESC").all();
        }
        if (can("support.manage")) {
          data.messages = db.prepare("SELECT m.*,u.username FROM messages m LEFT JOIN users u ON u.id=m.user_id ORDER BY m.created_at DESC").all();
        }
        if (can("documents.manage")) {
          data.documents = db.prepare("SELECT d.*,u.first_name||' '||u.last_name owner_name,lu.first_name||' '||lu.last_name lawyer_name FROM documents d JOIN users u ON u.id=d.owner_id LEFT JOIN lawyers l ON l.id=d.lawyer_id LEFT JOIN users lu ON lu.id=l.user_id ORDER BY d.created_at DESC").all().map(publicDocument);
        }
        if (can("content.manage")) {
          data.articles = db.prepare("SELECT * FROM articles ORDER BY created_at DESC").all();
          data.faqs = db.prepare("SELECT * FROM faqs ORDER BY sort_order,id").all();
        }
        if (can("services.manage")) data.services = db.prepare("SELECT * FROM services ORDER BY sort_order,id").all();
        if (can("settings.manage")) {
          data.settings = Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key NOT IN ('primary_admin_id','primary_admin_username') ORDER BY key").all().map((setting) => [setting.key, setting.value]));
        }
        if (can("admins.manage")) {
          data.admins = db.prepare("SELECT id,username,first_name,last_name,email,phone,status,created_at FROM users WHERE role='admin' ORDER BY created_at").all();
          data.permissions = db.prepare("SELECT admin_id,permission,allowed FROM admin_permissions ORDER BY admin_id,permission").all();
          data.permissionNames = permissionNames;
        }
        if (can("lawyers.verify")) data.slots = db.prepare("SELECT s.*,u.first_name||' '||u.last_name lawyer_name FROM appointment_slots s JOIN lawyers l ON l.id=s.lawyer_id JOIN users u ON u.id=l.user_id ORDER BY s.starts_at DESC").all();
        return json(res, 200, data);
      }

      return json(res, 403, { error: "نقش حساب معتبر نیست" });
    }

    if (req.method === "POST" && url.pathname === "/api/lawyer/action") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user || user.role !== "lawyer") return json(res, 403, { error: "ورود وکیل لازم است" });
      const lawyer = lawyerForUser(user.id);
      if (!lawyer) return json(res, 404, { error: "پروفایل وکیل پیدا نشد" });
      const action = cleanText(body.action);

      if (action === "set-online") {
        if (!lawyer.verified) return json(res, 409, { error: "فعال شدن وضعیت آنلاین پس از تأیید پروفایل ممکن است" });
        const online = body.online === true ? 1 : 0;
        db.prepare("UPDATE lawyers SET online=? WHERE id=?").run(online, lawyer.id);
        return json(res, 200, { ok: true, online: Boolean(online) });
      }

      if (action === "add-slot" || action === "create-slot") {
        if (!lawyer.verified) return json(res, 409, { error: "ثبت زمان آزاد پس از تأیید پروفایل ممکن است" });
        const consultationType = ["phone", "in_person"].includes(cleanText(body.consultationType)) ? cleanText(body.consultationType) : "phone";
        if (consultationType === "in_person" && !lawyer.in_person_enabled) return json(res, 409, { error: "مشاوره حضوری برای پروفایل شما فعال نیست" });
        const startsAt = validIsoFuture(body.startsAt);
        if (!startsAt) return json(res, 400, { error: "زمان شروع باید تاریخ ISO معتبر و در آینده باشد" });
        const rawEnd = body.endsAt ? validIsoFuture(body.endsAt) : new Date(Date.parse(startsAt) + 30 * 60000).toISOString();
        if (!rawEnd || Date.parse(rawEnd) <= Date.parse(startsAt) || Date.parse(rawEnd) - Date.parse(startsAt) > 4 * 3600000) return json(res, 400, { error: "زمان پایان باید پس از شروع و حداکثر چهار ساعت بعد باشد" });
        const overlap = db.prepare("SELECT 1 FROM appointment_slots WHERE lawyer_id=? AND status IN ('available','booked') AND datetime(starts_at)<datetime(?) AND datetime(ends_at)>datetime(?)").get(lawyer.id, rawEnd, startsAt);
        if (overlap) return json(res, 409, { error: "این بازه با زمان دیگری هم‌پوشانی دارد" });
        const result = db.prepare("INSERT INTO appointment_slots(lawyer_id,starts_at,ends_at,consultation_type,status) VALUES(?,?,?,?, 'available')").run(lawyer.id, startsAt, rawEnd, consultationType);
        return json(res, 201, { ok: true, id: Number(result.lastInsertRowid) });
      }

      if (action === "set-slot-status" || action === "update-slot") {
        const slotId = validId(body.id ?? body.slotId);
        const status = cleanText(body.status);
        if (!slotId || !["available", "blocked"].includes(status)) return json(res, 400, { error: "شناسه زمان و وضعیت معتبر لازم است" });
        const changed = db.prepare("UPDATE appointment_slots SET status=? WHERE id=? AND lawyer_id=? AND status<>'booked' AND datetime(starts_at)>datetime('now')").run(status, slotId, lawyer.id);
        if (!changed.changes) return json(res, 409, { error: "این زمان قابل تغییر نیست" });
        return json(res, 200, { ok: true });
      }

      if (action === "delete-slot") {
        const slotId = validId(body.id ?? body.slotId);
        if (!slotId) return json(res, 400, { error: "شناسه زمان معتبر نیست" });
        const deleted = db.prepare("DELETE FROM appointment_slots WHERE id=? AND lawyer_id=? AND status<>'booked'").run(slotId, lawyer.id);
        if (!deleted.changes) return json(res, 409, { error: "زمان رزروشده یا نامعتبر قابل حذف نیست" });
        return json(res, 200, { ok: true });
      }

      return json(res, 400, { error: "عملیات وکیل ناشناخته است" });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/action") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user || user.role !== "admin") return json(res, 403, { error: "ورود مدیر لازم است" });
      const action = cleanText(body.action);

      if (action === "verify-lawyer") {
        if (!hasAdminPermission(user, "lawyers.verify")) return json(res, 403, { error: "مجوز احراز وکیل را ندارید" });
        const lawyerId = validId(body.id ?? body.lawyerId);
        if (!lawyerId) return json(res, 400, { error: "شناسه وکیل معتبر نیست" });
        const approved = body.approved === true ? 1 : 0;
        const changed = db.prepare("UPDATE lawyers SET verified=?,online=CASE WHEN ?=0 THEN 0 ELSE online END,in_person_enabled=CASE WHEN ?=0 THEN 0 ELSE in_person_enabled END WHERE id=?").run(approved, approved, approved, lawyerId);
        if (!changed.changes) return json(res, 404, { error: "وکیل پیدا نشد" });
        return json(res, 200, { ok: true, verified: Boolean(approved) });
      }

      if (action === "set-lawyer-options") {
        if (!hasAdminPermission(user, "lawyers.verify")) return json(res, 403, { error: "مجوز مدیریت وکیل را ندارید" });
        const lawyerId = validId(body.id ?? body.lawyerId);
        const lawyer = lawyerId ? db.prepare("SELECT * FROM lawyers WHERE id=?").get(lawyerId) : null;
        if (!lawyer) return json(res, 404, { error: "وکیل پیدا نشد" });
        const featured = Object.hasOwn(body, "featured") ? (body.featured === true ? 1 : 0) : lawyer.featured;
        const online = Object.hasOwn(body, "online") ? (body.online === true ? 1 : 0) : lawyer.online;
        const inPerson = Object.hasOwn(body, "inPersonEnabled") ? (body.inPersonEnabled === true ? 1 : 0) : lawyer.in_person_enabled;
        if (!lawyer.verified && (online || inPerson)) return json(res, 409, { error: "ابتدا پروفایل وکیل را تأیید کنید" });
        db.prepare("UPDATE lawyers SET featured=?,online=?,in_person_enabled=? WHERE id=?").run(featured, online, inPerson, lawyer.id);
        return json(res, 200, { ok: true });
      }

      if (action === "set-user-status") {
        if (!hasAdminPermission(user, "users.manage")) return json(res, 403, { error: "مجوز مدیریت کاربران را ندارید" });
        const targetId = validId(body.id ?? body.userId);
        const status = cleanText(body.status);
        if (!targetId || !["active", "suspended"].includes(status)) return json(res, 400, { error: "کاربر و وضعیت معتبر لازم است" });
        if (targetId === primaryAdminId() || targetId === user.id) return json(res, 403, { error: "حساب مدیر فعال یا مدیر اصلی قابل تعلیق نیست" });
        const changed = db.prepare("UPDATE users SET status=? WHERE id=? AND role<>'admin'").run(status, targetId);
        if (!changed.changes) return json(res, 404, { error: "کاربر پیدا نشد" });
        if (status === "suspended") db.prepare("DELETE FROM sessions WHERE user_id=?").run(targetId);
        return json(res, 200, { ok: true });
      }

      if (action === "assign-question") {
        if (!hasAdminPermission(user, "questions.assign")) return json(res, 403, { error: "مجوز ارجاع پرسش را ندارید" });
        const questionId = validId(body.id ?? body.questionId);
        const requestedIds = Array.isArray(body.lawyerIds) ? [...new Set(body.lawyerIds.map(validId).filter(Boolean))] : [];
        if (!questionId || !requestedIds.length || requestedIds.length > 5) return json(res, 400, { error: "پرسش و یک تا پنج وکیل معتبر لازم است" });
        const question = db.prepare("SELECT * FROM questions WHERE id=?").get(questionId);
        if (!question || ["cancelled"].includes(question.status)) return json(res, 404, { error: "پرسش قابل ارجاع پیدا نشد" });
        const placeholders = requestedIds.map(() => "?").join(",");
        const validLawyers = db.prepare("SELECT l.id FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.id IN (" + placeholders + ") AND l.verified=1 AND u.status='active'").all(...requestedIds).map((item) => item.id);
        if (validLawyers.length !== requestedIds.length) return json(res, 400, { error: "یکی از وکلای انتخاب‌شده معتبر یا فعال نیست" });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE question_assignments SET status='withdrawn' WHERE question_id=? AND status='assigned'").run(question.id);
          const assignment = db.prepare("INSERT INTO question_assignments(question_id,lawyer_id,assigned_by,status) VALUES(?,?,?,'assigned') ON CONFLICT(question_id,lawyer_id) DO UPDATE SET assigned_by=excluded.assigned_by,status=CASE WHEN question_assignments.status='answered' THEN 'answered' ELSE 'assigned' END,assigned_at=CURRENT_TIMESTAMP");
          validLawyers.forEach((lawyerId) => assignment.run(question.id, lawyerId, user.id));
          const pendingCount = db.prepare("SELECT COUNT(*) count FROM question_assignments WHERE question_id=? AND status='assigned'").get(question.id).count;
          const answerCount = db.prepare("SELECT COUNT(*) count FROM answers WHERE question_id=?").get(question.id).count;
          db.prepare("UPDATE questions SET status=? WHERE id=?").run(pendingCount ? "assigned" : answerCount ? "answered" : "pending_assignment", question.id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return json(res, 200, { ok: true, assigned: validLawyers });
      }

      if (action === "moderate-answer") {
        if (!hasAdminPermission(user, "questions.assign")) return json(res, 403, { error: "مجوز مدیریت پاسخ‌ها را ندارید" });
        const answerId = validId(body.id ?? body.answerId);
        const published = body.published === true;
        if (!answerId) return json(res, 400, { error: "شناسه پاسخ معتبر لازم است" });
        const answer = db.prepare("SELECT a.id,q.publish_allowed FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.id=?").get(answerId);
        if (!answer) return json(res, 404, { error: "پاسخ پیدا نشد" });
        if (published && !answer.publish_allowed) return json(res, 409, { error: "موکل اجازه انتشار عمومی این پرسش را نداده است" });
        db.prepare("UPDATE answers SET published=? WHERE id=?").run(published ? 1 : 0, answer.id);
        return json(res, 200, { ok: true, published });
      }

      if (action === "assign-consultation") {
        if (!hasAdminPermission(user, "consultations.manage")) return json(res, 403, { error: "مجوز مدیریت مشاوره‌ها را ندارید" });
        const consultationId = validId(body.id ?? body.consultationId);
        const lawyerId = validId(body.lawyerId);
        if (!consultationId || !lawyerId) return json(res, 400, { error: "شناسه مشاوره و وکیل معتبر لازم است" });
        const consultation = db.prepare("SELECT * FROM consultations WHERE id=?").get(consultationId);
        const lawyer = db.prepare("SELECT l.* FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.id=? AND l.verified=1 AND u.status='active'").get(lawyerId);
        if (!consultation || !["pending_assignment", "registered"].includes(consultation.status)) return json(res, 409, { error: "مشاوره در این وضعیت قابل تخصیص نیست" });
        if (!lawyer) return json(res, 400, { error: "وکیل فعال و تأییدشده پیدا نشد" });
        if (consultation.type === "in_person" && consultation.slot_id && consultation.lawyer_id !== lawyer.id) return json(res, 409, { error: "نوبت حضوری به وکیل دیگری تعلق دارد" });
        db.prepare("UPDATE consultations SET lawyer_id=?,status='registered' WHERE id=?").run(lawyer.id, consultation.id);
        db.prepare("UPDATE documents SET lawyer_id=? WHERE consultation_id=?").run(lawyer.id, consultation.id);
        return json(res, 200, { ok: true });
      }

      if (action === "moderate-review") {
        if (!hasAdminPermission(user, "reviews.manage")) return json(res, 403, { error: "مجوز مدیریت نظرها را ندارید" });
        const reviewId = validId(body.id ?? body.reviewId);
        const status = cleanText(body.status);
        if (!reviewId || !["approved", "rejected", "pending"].includes(status)) return json(res, 400, { error: "نظر و وضعیت معتبر لازم است" });
        const review = db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewId);
        if (!review) return json(res, 404, { error: "نظر پیدا نشد" });
        db.prepare("UPDATE reviews SET status=? WHERE id=?").run(status, review.id);
        recomputeLawyerRating(review.lawyer_id);
        return json(res, 200, { ok: true });
      }

      if (action === "message-update") {
        if (!hasAdminPermission(user, "support.manage")) return json(res, 403, { error: "مجوز مدیریت پشتیبانی را ندارید" });
        const messageId = validId(body.id ?? body.messageId);
        const message = messageId ? db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) : null;
        if (!message) return json(res, 404, { error: "پیام پیدا نشد" });
        const status = Object.hasOwn(body, "status") ? cleanText(body.status) : message.status;
        const reply = Object.hasOwn(body, "reply") ? cleanText(body.reply) : message.admin_reply;
        if (!["new", "in_progress", "answered", "closed"].includes(status) || reply && reply.length > 5000) return json(res, 400, { error: "وضعیت یا پاسخ پشتیبانی معتبر نیست" });
        db.prepare("UPDATE messages SET status=?,admin_reply=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, reply || null, message.id);
        return json(res, 200, { ok: true });
      }

      if (action === "document-status") {
        if (!hasAdminPermission(user, "documents.manage")) return json(res, 403, { error: "مجوز مدیریت مدارک را ندارید" });
        const documentId = validId(body.id ?? body.documentId);
        const status = cleanText(body.status);
        if (!documentId || !["pending", "approved", "rejected"].includes(status)) return json(res, 400, { error: "مدرک و وضعیت معتبر لازم است" });
        const changed = db.prepare("UPDATE documents SET status=? WHERE id=?").run(status, documentId);
        if (!changed.changes) return json(res, 404, { error: "مدرک پیدا نشد" });
        return json(res, 200, { ok: true });
      }

      if (action === "delete-document") {
        if (!hasAdminPermission(user, "documents.manage")) return json(res, 403, { error: "مجوز مدیریت مدارک را ندارید" });
        const documentId = validId(body.id ?? body.documentId);
        const document = documentId ? db.prepare("SELECT * FROM documents WHERE id=?").get(documentId) : null;
        if (!document) return json(res, 404, { error: "مدرک پیدا نشد" });
        const diskPath = safeDiskPath(document.path);
        if (diskPath && existsSync(diskPath)) unlinkSync(diskPath);
        db.prepare("DELETE FROM documents WHERE id=?").run(document.id);
        return json(res, 200, { ok: true });
      }

      if (action === "service-save") {
        if (!hasAdminPermission(user, "services.manage")) return json(res, 403, { error: "مجوز مدیریت خدمات را ندارید" });
        const serviceId = body.id ? validId(body.id) : null;
        const title = validText(body.title, 2, 120);
        const description = validText(body.description, 5, 1000);
        const icon = /^[a-z0-9-]{2,40}$/.test(cleanText(body.icon)) ? cleanText(body.icon) : "scale";
        const sortOrder = Number(body.sortOrder ?? 0);
        const active = body.active === false ? 0 : 1;
        if (!title || !description || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) return json(res, 400, { error: "اطلاعات خدمت معتبر نیست" });
        try {
          if (serviceId) {
            const changed = db.prepare("UPDATE services SET title=?,description=?,icon=?,active=?,sort_order=? WHERE id=?").run(title, description, icon, active, sortOrder, serviceId);
            if (!changed.changes) return json(res, 404, { error: "خدمت پیدا نشد" });
          } else {
            db.prepare("INSERT INTO services(title,description,icon,active,sort_order) VALUES(?,?,?,?,?)").run(title, description, icon, active, sortOrder);
          }
        } catch (error) {
          if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "عنوان خدمت تکراری است" });
          throw error;
        }
        return json(res, 200, { ok: true });
      }

      if (action === "service-delete") {
        if (!hasAdminPermission(user, "services.manage")) return json(res, 403, { error: "مجوز مدیریت خدمات را ندارید" });
        const serviceId = validId(body.id ?? body.serviceId);
        if (!serviceId || !db.prepare("DELETE FROM services WHERE id=?").run(serviceId).changes) return json(res, 404, { error: "خدمت پیدا نشد" });
        return json(res, 200, { ok: true });
      }

      if (action === "faq-save") {
        if (!hasAdminPermission(user, "content.manage")) return json(res, 403, { error: "مجوز مدیریت محتوا را ندارید" });
        const faqId = body.id ? validId(body.id) : null;
        const category = validText(body.category, 2, 100);
        const question = validText(body.question, 5, 300);
        const answer = validText(body.answer, 10, 3000);
        const sortOrder = Number(body.sortOrder ?? 0);
        const active = body.active === false ? 0 : 1;
        if (!category || !question || !answer || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) return json(res, 400, { error: "اطلاعات پرسش متداول معتبر نیست" });
        if (faqId) {
          const changed = db.prepare("UPDATE faqs SET category=?,question=?,answer=?,active=?,sort_order=? WHERE id=?").run(category, question, answer, active, sortOrder, faqId);
          if (!changed.changes) return json(res, 404, { error: "پرسش متداول پیدا نشد" });
        } else {
          db.prepare("INSERT INTO faqs(category,question,answer,active,sort_order) VALUES(?,?,?,?,?)").run(category, question, answer, active, sortOrder);
        }
        return json(res, 200, { ok: true });
      }

      if (action === "faq-delete") {
        if (!hasAdminPermission(user, "content.manage")) return json(res, 403, { error: "مجوز مدیریت محتوا را ندارید" });
        const faqId = validId(body.id ?? body.faqId);
        if (!faqId || !db.prepare("DELETE FROM faqs WHERE id=?").run(faqId).changes) return json(res, 404, { error: "پرسش متداول پیدا نشد" });
        return json(res, 200, { ok: true });
      }

      if (action === "refund-order") {
        if (!hasAdminPermission(user, "payments.manage")) return json(res, 403, { error: "مجوز مدیریت پرداخت‌ها را ندارید" });
        const orderId = validId(body.id ?? body.orderId);
        const order = orderId ? db.prepare("SELECT * FROM orders WHERE id=?").get(orderId) : null;
        if (!order || !["paid", "refund_pending"].includes(order.status)) return json(res, 409, { error: "سفارش قابل بازپرداخت پیدا نشد" });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE orders SET status='refunded',refunded_at=CURRENT_TIMESTAMP WHERE id=?").run(order.id);
          if (order.consultation_id) db.prepare("UPDATE consultations SET payment_status='refunded' WHERE id=?").run(order.consultation_id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return json(res, 200, { ok: true });
      }

      if (action === "setting") {
        if (!hasAdminPermission(user, "settings.manage")) return json(res, 403, { error: "مجوز تنظیمات سایت را ندارید" });
        const key = cleanText(body.key);
        const allowedSettings = new Set([...publicSettingNames, "site_commission"]);
        if (!allowedSettings.has(key)) return json(res, 400, { error: "کلید تنظیمات مجاز نیست" });
        let value = cleanText(body.value);
        if (["default_phone_price", "default_in_person_price"].includes(key)) {
          const number = Number(value);
          if (!Number.isSafeInteger(number) || number <= 0 || number > 100000000) return json(res, 400, { error: "تعرفه معتبر نیست" });
          value = String(number);
        } else if (key === "site_commission") {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0 || number > 100) return json(res, 400, { error: "درصد کمیسیون باید بین صفر تا صد باشد" });
          value = String(number);
        } else if (["questions_enabled", "global_in_person_enabled", "maintenance_mode"].includes(key)) {
          if (!["0", "1", "true", "false"].includes(value.toLowerCase())) return json(res, 400, { error: "مقدار کلید روشن یا خاموش معتبر نیست" });
          value = ["1", "true"].includes(value.toLowerCase()) ? "1" : "0";
        } else if (!value || value.length > 500) {
          return json(res, 400, { error: "مقدار تنظیمات معتبر نیست" });
        }
        db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(key, value);
        return json(res, 200, { ok: true, key, value });
      }

      if (action === "create-admin") {
        if (!hasAdminPermission(user, "admins.manage")) return json(res, 403, { error: "مجوز مدیریت مدیران را ندارید" });
        const username = normalizeUsername(body.username);
        const password = String(body.password ?? "");
        const firstName = validText(body.firstName, 1, 80);
        const lastName = validText(body.lastName, 1, 80);
        const email = cleanText(body.email).toLowerCase();
        const phone = cleanText(body.phone);
        const requestedPermissions = Array.isArray(body.permissions) ? [...new Set(body.permissions.map(cleanText).filter((permission) => adminPermissionNames.has(permission)))] : [];
        if (!/^[\p{L}\p{N}._-]{3,40}$/u.test(username) || password.length < 8 || password.length > 128 || !firstName || !lastName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[+\d\s()-]{7,24}$/.test(phone)) return json(res, 400, { error: "اطلاعات حساب مدیر کامل یا معتبر نیست" });
        if (db.prepare("SELECT 1 FROM users WHERE username=? OR lower(email)=lower(?)").get(username, email)) return json(res, 409, { error: "نام کاربری یا ایمیل قبلاً ثبت شده است" });
        db.exec("BEGIN IMMEDIATE");
        try {
          const created = db.prepare("INSERT INTO users(username,password_hash,role,first_name,last_name,email,phone,status) VALUES(?,?,'admin',?,?,?,?, 'active')").run(username, hashPassword(password), firstName, lastName, email, phone);
          const permissionInsert = db.prepare("INSERT INTO admin_permissions(admin_id,permission,allowed) VALUES(?,?,1)");
          requestedPermissions.forEach((permission) => permissionInsert.run(created.lastInsertRowid, permission));
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "نام کاربری یا ایمیل قبلاً ثبت شده است" });
          throw error;
        }
        return json(res, 201, { ok: true });
      }

      if (action === "set-admin-permission") {
        if (!hasAdminPermission(user, "admins.manage")) return json(res, 403, { error: "مجوز مدیریت مدیران را ندارید" });
        const adminId = validId(body.adminId);
        const permission = cleanText(body.permission);
        if (!adminId || !adminPermissionNames.has(permission) || !db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin'").get(adminId)) return json(res, 400, { error: "مدیر یا مجوز معتبر نیست" });
        if (adminId === primaryAdminId()) return json(res, 403, { error: "دسترسی‌های مدیر اصلی قابل محدود کردن نیست" });
        const enabled = body.enabled === true ? 1 : 0;
        db.prepare("INSERT INTO admin_permissions(admin_id,permission,allowed) VALUES(?,?,?) ON CONFLICT(admin_id,permission) DO UPDATE SET allowed=excluded.allowed").run(adminId, permission, enabled);
        return json(res, 200, { ok: true });
      }

      if (action === "publish-article") {
        if (!hasAdminPermission(user, "content.manage")) return json(res, 403, { error: "مجوز مدیریت محتوا را ندارید" });
        const articleId = validId(body.id ?? body.articleId);
        const publish = body.publish !== false;
        if (!articleId) return json(res, 400, { error: "شناسه مقاله معتبر نیست" });
        const changed = db.prepare("UPDATE articles SET status=?,published_at=? WHERE id=?").run(publish ? "published" : "draft", publish ? new Date().toISOString() : null, articleId);
        if (!changed.changes) return json(res, 404, { error: "مقاله پیدا نشد" });
        return json(res, 200, { ok: true });
      }

      return json(res, 400, { error: "عملیات مدیر ناشناخته است" });
    }

    if (req.method === "POST" && url.pathname === "/api/articles") {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!user || !hasAdminPermission(user, "content.manage")) return json(res, 403, { error: "مجوز مدیریت محتوا لازم است" });
      const action = cleanText(body.action || "save");
      const articleId = body.id ? validId(body.id) : null;
      if (action === "delete") {
        if (!articleId || !db.prepare("DELETE FROM articles WHERE id=?").run(articleId).changes) return json(res, 404, { error: "مقاله پیدا نشد" });
        return json(res, 200, { ok: true });
      }
      const slug = cleanText(body.slug).toLowerCase();
      const title = validText(body.title, 3, 220);
      const excerpt = validText(body.excerpt, 10, 1000);
      const articleBody = validText(body.body, 20, 30000);
      const category = validText(body.category, 2, 100);
      const author = validText(body.author || user.first_name + " " + user.last_name, 2, 160);
      const publish = body.publish === true || cleanText(body.status) === "published";
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 160 || !title || !excerpt || !articleBody || !category || !author) return json(res, 400, { error: "عنوان، نشانی انگلیسی، خلاصه و متن معتبر لازم است" });
      try {
        if (articleId) {
          const changed = db.prepare("UPDATE articles SET slug=?,title=?,excerpt=?,body=?,category=?,author=?,status=?,published_at=? WHERE id=?").run(slug, title, excerpt, articleBody, category, author, publish ? "published" : "draft", publish ? new Date().toISOString() : null, articleId);
          if (!changed.changes) return json(res, 404, { error: "مقاله پیدا نشد" });
        } else {
          db.prepare("INSERT INTO articles(slug,title,excerpt,body,category,author,status,published_at) VALUES(?,?,?,?,?,?,?,?)").run(slug, title, excerpt, articleBody, category, author, publish ? "published" : "draft", publish ? new Date().toISOString() : null);
        }
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "نشانی انگلیسی مقاله تکراری است" });
        throw error;
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "مسیر API پیدا نشد" });
  } catch (error) {
    if (error instanceof ApiError) {
      const uploadErrors = {
        PAYLOAD_TOO_LARGE: "حجم اطلاعات ارسالی بیش از حد مجاز است",
        INVALID_JSON: "بدنه درخواست JSON معتبر نیست",
        INVALID_MULTIPART: "ساختار فایل ارسالی معتبر نیست",
        TOO_MANY_FILES: "در هر درخواست فقط یک فایل قابل بارگذاری است",
        INVALID_MULTIPART_FIELD: "فیلد همراه فایل معتبر نیست",
        FILE_REQUIRED: "انتخاب فایل الزامی است",
        FILE_SIZE_INVALID: "حجم فایل معتبر نیست",
        UNSUPPORTED_FILE: "فقط PDF، JPG و PNG پذیرفته می‌شود",
        FILE_EXTENSION_MISMATCH: "پسوند فایل با محتوای آن تطابق ندارد",
        FILE_MIME_MISMATCH: "نوع فایل با محتوای آن تطابق ندارد",
      };
      return json(res, error.statusCode, { error: uploadErrors[error.message] || error.message });
    }
    console.error("Dadrah API error:", error);
    return json(res, 500, { error: "خطای داخلی سرور رخ داد" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("Dadrah local API: http://localhost:" + port);
});

const closeServer = () => server.close(() => {
  db.close();
  process.exit(0);
});
process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);
