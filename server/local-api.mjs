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
  "free_question_limit", "max_question_lawyers", "text_message_limit", "default_text_price",
  "phone_price_min", "phone_price_max", "text_price_min", "text_price_max", "in_person_price_min", "in_person_price_max",
  "footer_config", "terms_content", "privacy_content", "trust_items", "article_tags", "site_views",
  "logo_light_url", "logo_dark_url", "favicon_url", "hero_images",
  "stats_enabled", "stats_title", "stat_labels", "trust_enabled",
  "stats_views_label", "stats_consultations_label", "stats_reviews_label", "stats_lawyers_label",
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
const validTextList = (value, maxItems = 12, maxLength = 120) => {
  let items = value;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { items = items.split(/\r?\n/); }
  }
  if (!Array.isArray(items) || items.length > maxItems) return null;
  const cleaned = [...new Set(items.map((item) => cleanText(item)).filter(Boolean))];
  return cleaned.some((item) => item.length < 2 || item.length > maxLength) ? null : cleaned;
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
const accountFor = (userId) => db.prepare("SELECT id,username,role,first_name,last_name,email,phone,province,city,status,avatar_url,created_at FROM users WHERE id=?").get(userId);
const lawyerForUser = (userId) => db.prepare("SELECT * FROM lawyers WHERE user_id=?").get(userId);
const specialtyRowsForLawyer = (lawyerId) => db.prepare(`SELECT s.id,s.title,s.active,s.sort_order
  FROM lawyer_specialties ls JOIN services s ON s.id=ls.service_id
  WHERE ls.lawyer_id=? ORDER BY s.sort_order,s.id`).all(lawyerId);
const specialtyIdsForLawyer = (lawyerId) => specialtyRowsForLawyer(lawyerId).map((service) => service.id);
const resolveActiveSpecialties = (rawIds, legacyValue = "", allowedInactiveIds = []) => {
  let ids = [];
  if (Array.isArray(rawIds)) {
    if (rawIds.length < 1 || rawIds.length > 8) return null;
    const parsedIds = rawIds.map(validId);
    if (parsedIds.some((id) => !id)) return null;
    ids = [...new Set(parsedIds)];
    if (ids.length !== rawIds.length) return null;
  } else {
    const titles = [...new Set(cleanText(legacyValue).split(/[،,|]/).map((title) => title.trim()).filter(Boolean))];
    if (titles.length < 1 || titles.length > 8) return null;
    const activeServices = db.prepare("SELECT id,title FROM services WHERE active=1").all();
    const byTitle = new Map(activeServices.map((service) => [service.title, service.id]));
    if (titles.some((title) => !byTitle.has(title))) return null;
    ids = titles.map((title) => byTitle.get(title));
  }
  const placeholders = ids.map(() => "?").join(",");
  const services = db.prepare(`SELECT id,title,active,sort_order FROM services WHERE id IN (${placeholders}) ORDER BY sort_order,id`).all(...ids);
  const allowedInactive = new Set(allowedInactiveIds);
  return services.length === ids.length && services.every((service) => service.active || allowedInactive.has(service.id)) ? services : null;
};
const refreshLawyerSpecialtyCache = (lawyerId) => {
  const labels = specialtyRowsForLawyer(lawyerId).map((service) => service.title).join("، ");
  db.prepare("UPDATE lawyers SET specialties=? WHERE id=?").run(labels || "در انتظار انتخاب تخصص", lawyerId);
  return labels;
};
const replaceLawyerSpecialties = (lawyerId, services) => {
  db.prepare("DELETE FROM lawyer_specialties WHERE lawyer_id=?").run(lawyerId);
  const insert = db.prepare("INSERT INTO lawyer_specialties(lawyer_id,service_id) VALUES(?,?)");
  for (const service of services) insert.run(lawyerId, service.id);
  return refreshLawyerSpecialtyCache(lawyerId);
};
const settingNumber = (key, fallback) => Number(db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? fallback);
const answerLimit = () => settingNumber("max_question_lawyers", 3);
const settingsPayload = () => Object.fromEntries(db.prepare("SELECT key,value FROM settings").all().filter((row) => publicSettingNames.has(row.key)).map((row) => [row.key, row.value]));
const jsonSetting = (key, fallback) => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? "null") ?? fallback; } catch { return fallback; } };
const priceAllowed = (type, amount) => Number.isSafeInteger(amount) && amount >= settingNumber(`${type}_price_min`, 1) && amount <= settingNumber(`${type}_price_max`, 100000000);
const isStoredSiteMediaUrl = (value) => {
  const match = /^\/api\/media\/([1-9]\d*)$/.exec(cleanText(value));
  const mediaId = match ? validId(match[1]) : null;
  return Boolean(mediaId && db.prepare("SELECT 1 FROM documents WHERE id=? AND kind='site_media' AND status='approved'").get(mediaId));
};

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

const documentsForOwner = (ownerId) => db.prepare("SELECT id,owner_id,lawyer_id,question_id,consultation_id,kind,file_name,mime_type,size_bytes,status,created_at FROM documents WHERE owner_id=? AND consultation_id IS NULL AND question_id IS NULL ORDER BY created_at DESC").all(ownerId).map(publicDocument);
const documentsForLawyer = (lawyer) => db.prepare(`
  SELECT DISTINCT d.id,d.owner_id,d.lawyer_id,d.question_id,d.consultation_id,d.kind,d.file_name,d.mime_type,d.size_bytes,d.status,d.created_at
  FROM documents d
  WHERE d.consultation_id IS NULL AND d.question_id IS NULL AND (d.owner_id=? OR d.lawyer_id=?)
  ORDER BY d.created_at DESC
`).all(lawyer.user_id, lawyer.id).map(publicDocument);
const documentsForQuestion = (questionId) => db.prepare("SELECT id,owner_id,lawyer_id,question_id,consultation_id,kind,file_name,mime_type,size_bytes,status,created_at FROM documents WHERE question_id=? ORDER BY created_at").all(questionId).map(publicDocument);
const documentsForConsultation = (consultationId, viewer) => db.prepare("SELECT id,owner_id,lawyer_id,question_id,consultation_id,kind,file_name,mime_type,size_bytes,status,created_at FROM documents WHERE consultation_id=? ORDER BY created_at,id")
  .all(consultationId)
  .filter((document) => mayAccessDocument(viewer, document))
  .map(publicDocument);

const mayAccessDocument = (user, document) => {
  if (!user || !document) return false;
  if (document.owner_id === user.id) return true;
  if (user.role === "admin") return hasAdminPermission(user, "documents.manage");
  if (document.consultation_id) {
    if (user.role === "client") return Boolean(db.prepare("SELECT 1 FROM consultations WHERE id=? AND client_id=?").get(document.consultation_id, user.id));
    const lawyer = user.role === "lawyer" ? lawyerForUser(user.id) : null;
    return Boolean(lawyer && db.prepare("SELECT 1 FROM consultations WHERE id=? AND lawyer_id=?").get(document.consultation_id, lawyer.id));
  }
  if (user.role !== "lawyer") return false;
  const lawyer = lawyerForUser(user.id);
  if (!lawyer) return false;
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
  if (!consultation?.lawyer_id || consultation.type !== "text") return null;
  db.prepare("INSERT OR IGNORE INTO conversations(consultation_id,client_id,lawyer_id,status) VALUES(?,?,?,?)").run(
    consultation.id,
    consultation.client_id,
    consultation.lawyer_id,
    consultation.status === "completed" ? "closed" : "open",
  );
  return db.prepare("SELECT * FROM conversations WHERE consultation_id=?").get(consultation.id);
};

const conversationTurnUsage = (conversationId, clientId, lawyerUserId) => {
  const senders = db.prepare("SELECT sender_id FROM chat_messages WHERE conversation_id=? ORDER BY created_at,id").all(conversationId);
  const turns = { client: 0, lawyer: 0 };
  let lastSenderId = null;
  for (const { sender_id: senderId } of senders) {
    if (senderId === lastSenderId) continue;
    if (senderId === clientId) turns.client += 1;
    if (senderId === lawyerUserId) turns.lawyer += 1;
    lastSenderId = senderId;
  }
  return { ...turns, lastSenderId };
};

const conversationPayloads = (role, id) => {
  const rows = db.prepare(`SELECT cv.*,c.topic,c.message_limit,c.source_question_id,c.type consultation_type,c.status consultation_status,
    c.scheduled_at,c.amount,c.payment_status,o.tracking_code,
    lu.first_name||' '||lu.last_name lawyer_name,cu.first_name||' '||cu.last_name client_name,
    COALESCE(lu.avatar_url,'/avatars/default-lawyer.png') lawyer_avatar_url,
    COALESCE(cu.avatar_url,'/avatars/default-client.png') client_avatar_url
    FROM conversations cv JOIN consultations c ON c.id=cv.consultation_id
    JOIN lawyers l ON l.id=cv.lawyer_id JOIN users lu ON lu.id=l.user_id JOIN users cu ON cu.id=cv.client_id
    LEFT JOIN orders o ON o.consultation_id=c.id
    WHERE ${role === "client" ? "cv.client_id" : "cv.lawyer_id"}=? AND c.type='text' ORDER BY cv.created_at DESC`).all(id);
  const messages = db.prepare("SELECT cm.id,cm.conversation_id,cm.sender_id,cm.body,cm.created_at,u.first_name||' '||u.last_name sender_name,u.role sender_role,COALESCE(u.avatar_url,'/avatars/default-'||u.role||'.png') sender_avatar_url FROM chat_messages cm JOIN users u ON u.id=cm.sender_id WHERE cm.conversation_id=? ORDER BY cm.created_at,cm.id");
  const attachments = db.prepare("SELECT d.*,u.first_name||' '||u.last_name owner_name FROM documents d JOIN users u ON u.id=d.owner_id WHERE d.consultation_id=? OR d.question_id=? ORDER BY d.created_at,d.id");
  const viewer = accountFor(role === "client" ? id : db.prepare("SELECT user_id FROM lawyers WHERE id=?").get(id)?.user_id);
  return rows.map((row) => {
    const limit = row.message_limit || settingNumber("text_message_limit", 3);
    const lawyerUserId = db.prepare("SELECT user_id FROM lawyers WHERE id=?").get(row.lawyer_id)?.user_id;
    const usage = conversationTurnUsage(row.id, row.client_id, lawyerUserId);
    return {
      ...row,
      consultation: { id: row.consultation_id, lawyer_id: row.lawyer_id, type: row.consultation_type, topic: row.topic, status: row.consultation_status, source_question_id: row.source_question_id, scheduled_at: row.scheduled_at, amount: row.amount, payment_status: row.payment_status, message_limit: row.message_limit, tracking_code: row.tracking_code },
      messages: messages.all(row.id),
      attachments: attachments.all(row.consultation_id, row.source_question_id).filter((document) => mayAccessDocument(viewer, document)).map(publicDocument),
      turn_limit: limit,
      turn_usage: { client: usage.client, lawyer: usage.lawyer },
      turns_remaining: { client: Math.max(0, limit - usage.client), lawyer: Math.max(0, limit - usage.lawyer) },
      quota_complete: usage.client >= limit && usage.lawyer >= limit,
      can_send: {
        client: row.status === "open" && (usage.lastSenderId === row.client_id || usage.client < limit),
        lawyer: row.status === "open" && (usage.lastSenderId === lawyerUserId || usage.lawyer < limit),
      },
    };
  });
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

const notificationPayload = (user, data) => {
  const seen = new Set(jsonSetting(`notification_seen_${user.id}`, []));
  const items = [];
  const add = (id, section, title, createdAt) => { if (!seen.has(id)) items.push({ id, section, title, created_at: createdAt || new Date().toISOString() }); };
  for (const question of data.questions || []) {
    if (user.role === "client") {
      if (question.status === "cancelled") add(`question-cancelled-${question.id}`, "questions", `پرسشت درباره ${question.topic} توسط مدیر لغو شد.`, question.created_at);
      for (const answer of question.answers || []) add(`answer-${answer.id}`, "questions", `به پرسشت درباره ${question.topic} پاسخ دادن.`, answer.created_at);
    } else if (user.role === "lawyer" && question.status === "cancelled") add(`question-cancelled-${question.id}`, "questions", `پرسش ${question.topic} لغو شد و دیگه نیاز نیست پاسخی براش بفرستی.`, question.created_at);
    else if (user.role === "lawyer" && question.assignment_status === "assigned") add(`question-${question.id}`, "questions", `یک پرسش تازه درباره ${question.topic} داری.`, question.created_at);
    else if (user.role === "admin" && question.status === "pending_assignment") add(`question-${question.id}`, "questions", "یک پرسش منتظر ارجاعه.", question.created_at);
  }
  for (const item of data.consultations || []) {
    if (item.status === "cancelled" || item.status === "rejected") continue;
    const title = item.status === "pending_coordination" ? "پشتیبانی برای هماهنگی زمان مشاوره باهات تماس می‌گیره." : item.scheduled_at ? `زمان مشاوره‌ات هماهنگ شد: ${item.scheduled_at}` : `وضعیت مشاوره ${item.topic} به‌روز شد.`;
    add(`consultation-${item.id}-${item.status}-${item.scheduled_at || ""}`, "consultations", title, item.created_at);
  }
  for (const conversation of data.conversations || []) for (const message of conversation.messages || []) if (message.sender_id !== user.id) add(`chat-${message.id}`, "chat", "توی گفت‌وگوت یک پیام تازه داری.", message.created_at);
  for (const message of data.messages || []) if (user.role === "admin" ? message.status === "new" : Boolean(message.admin_reply)) add(`support-${message.id}-${message.status}`, "messages", user.role === "admin" ? "یک پیام پشتیبانی تازه داری." : "پشتیبانی به پیامت پاسخ داده.", message.updated_at || message.created_at);
  for (const review of data.reviews || []) if (user.role !== "client") add(`review-${review.id}-${review.status}`, "reviews", "یک نظر تازه ثبت شده.", review.created_at);
  if (user.role === "lawyer" && !data.profile?.verified) add(`profile-${data.profile?.profile_completed ? "documents" : "incomplete"}`, "profile", "برای تأیید حسابت، پروفایلت رو کامل کن و مدارک هویتی و پروانه‌ات رو بفرست.");
  for (const lawyer of data.lawyers || []) if (!lawyer.verified) add(`lawyer-${lawyer.id}`, "lawyers", "یک وکیل منتظر بررسی پروفایله.", lawyer.created_at);
  for (const article of data.articles || []) if (user.role === "admin" ? article.status === "pending_review" : article.status === "published") add(`article-${article.id}-${article.status}`, "articles", user.role === "admin" ? "یک مقاله منتظر تأییدته." : "مقاله‌ات منتشر شد.", article.created_at);
  for (const document of data.documents || []) if (!["avatar", "article_cover", "site_media"].includes(document.kind)) add(`document-${document.id}-${document.status}`, "documents", document.status === "pending" ? "یک مدرک منتظر بررسیه." : "مدرک پرونده‌ات آماده است.", document.created_at);
  for (const account of data.users || []) add(`user-${account.id}`, "users", "یک کاربر تازه به سایت اضافه شده.", account.created_at);
  const notificationItems = items.slice(0, 200);
  const notificationCounts = {};
  for (const item of notificationItems) notificationCounts[item.section] = (notificationCounts[item.section] || 0) + 1;
  return { notificationItems, notificationCounts };
};

const publicBootstrap = () => {
  const lawyers = db.prepare(`
    SELECT l.id,l.license_number,
      COALESCE((SELECT group_concat(s.title,'، ') FROM lawyer_specialties ls JOIN services s ON s.id=ls.service_id WHERE ls.lawyer_id=l.id AND s.active=1),'') specialties,
      COALESCE((SELECT group_concat(s.id,',') FROM lawyer_specialties ls JOIN services s ON s.id=ls.service_id WHERE ls.lawyer_id=l.id AND s.active=1),'') specialty_ids,
      l.bio,l.phone_price,l.text_price,l.in_person_price,l.rating,l.verified,l.featured,l.online,l.in_person_enabled,
      u.first_name||' '||u.last_name name,u.avatar_url,u.city,u.province,u.created_at joined_at,u.created_at created_at,
      CASE WHEN l.online=1 THEN 'کمتر از ۱ ساعت' ELSE 'حداکثر ۴ ساعت' END response_time,
      (SELECT COUNT(*) FROM consultations c WHERE c.lawyer_id=l.id AND c.status='completed') consultations_count,
      (SELECT COUNT(*) FROM answers a WHERE a.lawyer_id=l.id) answers_count,
      (SELECT COUNT(*) FROM reviews r WHERE r.lawyer_id=l.id AND r.status='approved') reviews_count
    FROM lawyers l JOIN users u ON u.id=l.user_id
    WHERE l.verified=1 AND u.status='active'
    ORDER BY l.featured DESC,l.rating DESC
  `).all();
  const slots = db.prepare("SELECT id,lawyer_id,starts_at,ends_at,consultation_type,status FROM appointment_slots WHERE consultation_type='in_person' AND status='available' AND datetime(starts_at)>datetime('now') ORDER BY starts_at").all();
  const publicLawyers = lawyers.map((lawyer) => ({ ...lawyer, available_slots: slots.filter((slot) => slot.lawyer_id === lawyer.id) }));
  const questionRows = db.prepare(`
    SELECT q.id,q.topic,q.body,q.kind,q.status,q.urgent,q.created_at
    FROM questions q
    WHERE q.publish_allowed=1 AND q.status<>'cancelled' AND EXISTS(SELECT 1 FROM answers a WHERE a.question_id=q.id AND a.published=1)
    ORDER BY q.created_at DESC LIMIT 20
  `).all();
  const publicAnswers = db.prepare("SELECT a.id,a.question_id,a.lawyer_id,a.body,a.created_at,u.first_name||' '||u.last_name lawyer_name FROM answers a JOIN lawyers l ON l.id=a.lawyer_id JOIN users u ON u.id=l.user_id WHERE a.question_id=? AND a.published=1 ORDER BY a.created_at");
  const questions = questionRows.map((question) => {
    const answers = publicAnswers.all(question.id).slice(0, answerLimit());
    return { ...question, answers, answer: answers[0]?.body ?? null, lawyer_name: answers[0]?.lawyer_name ?? null };
  });
  const settingPlaceholders = [...publicSettingNames].map(() => "?").join(",");
  const settings = Object.fromEntries(db.prepare(`SELECT key,value FROM settings WHERE key IN (${settingPlaceholders})`).all(...publicSettingNames).map((item) => [item.key, item.value]));
  return {
    lawyers: publicLawyers,
    articles: db.prepare("SELECT id,slug,title,excerpt,body,category,author,cover_image,tags,author_avatar,published_at,created_at FROM articles WHERE status='published' ORDER BY published_at DESC").all(),
    questions,
    services: db.prepare(`SELECT s.id,s.title,s.description,s.back_description,s.case_types,s.icon,s.sort_order,
      COUNT(CASE WHEN l.verified=1 AND u.status='active' THEN 1 END) lawyer_count
      FROM services s
      LEFT JOIN lawyer_specialties ls ON ls.service_id=s.id
      LEFT JOIN lawyers l ON l.id=ls.lawyer_id
      LEFT JOIN users u ON u.id=l.user_id
      WHERE s.active=1 GROUP BY s.id ORDER BY s.sort_order,s.id`).all(),
    faqs: db.prepare("SELECT id,category,question,answer,sort_order FROM faqs WHERE active=1 ORDER BY sort_order,id").all(),
    reviews: db.prepare("SELECT r.id,r.lawyer_id,r.consultation_type,r.body,r.rating,r.created_at,u.first_name||' '||substr(u.last_name,1,1)||'.' client_name,lu.first_name||' '||lu.last_name lawyer_name FROM reviews r JOIN users u ON u.id=r.client_id JOIN lawyers l ON l.id=r.lawyer_id JOIN users lu ON lu.id=l.user_id WHERE r.status='approved' ORDER BY r.created_at DESC LIMIT 20").all(),
    settings,
    stats: { views: settingNumber("site_views", 0), consultations: db.prepare("SELECT COUNT(*) count FROM consultations WHERE payment_status IN ('simulated_paid','paid')").get().count, reviews: db.prepare("SELECT COUNT(*) count FROM reviews WHERE status='approved'").get().count, rating: db.prepare("SELECT ROUND(AVG(rating),1) rating FROM reviews WHERE status='approved'").get().rating ?? 0, lawyers: publicLawyers.length },
  };
};

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, null);
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, database: dbPath });
    if (req.method === "GET" && url.pathname === "/api/bootstrap") return json(res, 200, publicBootstrap());
    if (req.method === "POST" && url.pathname === "/api/visit") {
      db.prepare("INSERT INTO settings(key,value) VALUES('site_views','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/forgot-password") {
      const body = await readBody(req);
      if (!/^09\d{9}$/.test(cleanText(body.phone))) return json(res, 400, { error: "شماره موبایلت رو با ۰۹ و ۱۱ رقم بنویس." });
      return json(res, 200, { ok: true, smsEnabled: false, message: "اگه با این شماره حساب داشته باشی، بعد از فعال شدن سرویس پیامک می‌تونی رمزت رو بازیابی کنی. فعلاً با پشتیبانی تماس بگیر." });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password ?? "");
      const expectedRole = cleanText(body.expectedRole);
      if (expectedRole && !["client", "lawyer", "admin"].includes(expectedRole)) return json(res, 400, { error: "نوع حسابت رو درست انتخاب کن." });
      const user = username.length <= 80 ? db.prepare("SELECT * FROM users WHERE username=? AND status='active'").get(username) : null;
      if (!user || !verifyPassword(password, user.password_hash)) return json(res, 401, { error: "نام کاربری یا رمز عبور نادرست است" });
      if (expectedRole && user.role !== expectedRole) return json(res, 403, { error: "این حساب با نوع ورودی که انتخاب کردی فرق داره. نوع حسابت رو درست انتخاب کن." });
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
      if (!/^09\d{9}$/.test(phone)) return json(res, 400, { error: "شماره موبایلت رو با ۰۹ و ۱۱ رقم بنویس." });
      const province = validText(body.province, 0, 80) ?? "";
      const city = validText(body.city, 0, 80) ?? "";
      const licenseNumber = role === "lawyer" ? validText(body.licenseNumber, 2, 80) : null;
      const selectedSpecialties = role === "lawyer" ? resolveActiveSpecialties(body.specialtyIds, body.specialty ?? body.specialties) : null;
      if (role === "lawyer" && (!licenseNumber || !selectedSpecialties)) return json(res, 400, { error: "شماره پروانه و حداقل یک حوزه تخصصی تعریف‌شده توسط مدیر لازمه؛ حداکثر ۸ مورد انتخاب کن." });
      if (db.prepare("SELECT 1 FROM users WHERE username=? OR lower(email)=lower(?)").get(username, email)) return json(res, 409, { error: "نام کاربری یا ایمیل قبلاً ثبت شده است" });
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare("INSERT INTO users(username,password_hash,role,first_name,last_name,email,phone,province,city,status) VALUES(?,?,?,?,?,?,?,?,?,'active')").run(username, hashPassword(password), role, firstName, lastName, email, phone, province, city);
        db.prepare("UPDATE users SET avatar_url=? WHERE id=?").run(`/avatars/default-${role}.png`, result.lastInsertRowid);
        if (role === "lawyer") {
          const defaultPhone = Number(db.prepare("SELECT value FROM settings WHERE key='default_phone_price'").get()?.value || 480000);
          const lawyerResult = db.prepare("INSERT INTO lawyers(user_id,license_number,specialties,bio,phone_price,text_price,verified,in_person_enabled) VALUES(?,?,?,?,?,0,0,0)").run(result.lastInsertRowid, licenseNumber, selectedSpecialties.map((service) => service.title).join("، "), "پروفایل در انتظار تکمیل و تأیید مدیر", defaultPhone);
          replaceLawyerSpecialties(Number(lawyerResult.lastInsertRowid), selectedSpecialties);
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
        const currentSpecialties = specialtyRowsForLawyer(lawyer.id);
        const specialtySelectionProvided = Object.hasOwn(body, "specialtyIds") || Object.hasOwn(body, "specialties") || Object.hasOwn(body, "specialty");
        const selectedSpecialties = specialtySelectionProvided
          ? resolveActiveSpecialties(body.specialtyIds, body.specialties ?? body.specialty, currentSpecialties.filter((service) => !service.active).map((service) => service.id))
          : currentSpecialties.length ? currentSpecialties : resolveActiveSpecialties(undefined, lawyer.specialties);
        const bio = validText(value("bio", "bio", lawyer.bio), 10, 4000);
        const phonePrice = Number(value("phonePrice", "phone_price", lawyer.phone_price));
        const textPrice = Number(value("textPrice", "text_price", lawyer.text_price || settingNumber("default_text_price", 200000)));
        const rawInPerson = value("inPersonPrice", "in_person_price", lawyer.in_person_price);
        const inPersonPrice = rawInPerson === null || rawInPerson === "" ? null : Number(rawInPerson);
        if (!licenseNumber || !selectedSpecialties || !bio) return json(res, 400, { error: "اطلاعات پروفایل و حوزه‌های تخصصی معتبر نیست؛ بین ۱ تا ۸ مورد انتخاب کن." });
        if (!Number.isSafeInteger(phonePrice) || phonePrice <= 0 || phonePrice > 100000000) return json(res, 400, { error: "تعرفه تلفنی معتبر نیست" });
        if (inPersonPrice !== null && (!Number.isSafeInteger(inPersonPrice) || inPersonPrice <= 0 || inPersonPrice > 100000000)) return json(res, 400, { error: "تعرفه حضوری معتبر نیست" });
        if (!priceAllowed("phone", phonePrice) || !priceAllowed("text", textPrice) || inPersonPrice !== null && !priceAllowed("in_person", inPersonPrice)) return json(res, 400, { error: "نرخی که گذاشتی باید داخل بازه تعیین‌شده مدیر باشه." });
        const currentIds = currentSpecialties.map((service) => service.id).sort((a, b) => a - b).join(",");
        const nextIds = selectedSpecialties.map((service) => service.id).sort((a, b) => a - b).join(",");
        const verificationChanged = licenseNumber !== lawyer.license_number || currentIds !== nextIds;
        lawyerUpdate = { licenseNumber, specialties: selectedSpecialties.map((service) => service.title).join("، "), selectedSpecialties, bio, phonePrice, textPrice, inPersonPrice, verificationChanged };
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE users SET first_name=?,last_name=?,email=?,phone=?,province=?,city=? WHERE id=?").run(firstName, lastName, email, phone, province, city, user.id);
        if (lawyerUpdate) {
          db.prepare(`UPDATE lawyers SET license_number=?,specialties=?,bio=?,phone_price=?,text_price=?,in_person_price=?,profile_completed=1,
            verified=CASE WHEN ? THEN 0 ELSE verified END,online=CASE WHEN ? THEN 0 ELSE online END,in_person_enabled=CASE WHEN ? THEN 0 ELSE in_person_enabled END
            WHERE user_id=?`).run(lawyerUpdate.licenseNumber, lawyerUpdate.specialties, lawyerUpdate.bio, lawyerUpdate.phonePrice, lawyerUpdate.textPrice, lawyerUpdate.inPersonPrice, lawyerUpdate.verificationChanged ? 1 : 0, lawyerUpdate.verificationChanged ? 1 : 0, lawyerUpdate.verificationChanged ? 1 : 0, user.id);
          replaceLawyerSpecialties(lawyer.id, lawyerUpdate.selectedSpecialties);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "این ایمیل قبلاً ثبت شده است" });
        throw error;
      }
      const account = accountFor(user.id);
      const profile = user.role === "lawyer" ? db.prepare("SELECT l.*,u.first_name,u.last_name,u.email,u.phone,u.province,u.city FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.user_id=?").get(user.id) : account;
      if (user.role === "lawyer") profile.specialty_ids = specialtyIdsForLawyer(profile.id);
      return json(res, 200, { ok: true, account, profile, verificationReset: Boolean(lawyerUpdate?.verificationChanged) });
    }

    if (req.method === "POST" && ["/api/avatar", "/api/article-cover"].includes(url.pathname)) {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "اول وارد حسابت شو." });
      const avatar = url.pathname === "/api/avatar";
      if (!avatar && user.role !== "lawyer" && !hasAdminPermission(user, "content.manage")) return json(res, 403, { error: "اجازه بارگذاری تصویر مقاله رو نداری." });
      const { file } = await parseMultipart(req);
      const { mimeType, extension } = inspectUpload(file);
      if (!mimeType.startsWith("image/")) return json(res, 415, { error: "برای عکس فقط JPG یا PNG انتخاب کن." });
      const storedName = `${randomBytes(24).toString("hex")}${extension}`;
      const diskPath = resolve(uploadsDirectory, storedName);
      writeFileSync(diskPath, file.buffer, { flag: "wx", mode: 0o600 });
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare("INSERT INTO documents(owner_id,kind,file_name,path,mime_type,size_bytes,status) VALUES(?,?,?,?,?,?,'approved')").run(user.id, avatar ? "avatar" : "article_cover", `image${extension}`, `data/uploads/${storedName}`, mimeType, file.buffer.length);
        const mediaUrl = `/api/media/${result.lastInsertRowid}`;
        if (avatar) db.prepare("UPDATE users SET avatar_url=? WHERE id=?").run(mediaUrl, user.id);
        db.exec("COMMIT");
        return json(res, 201, { ok: true, url: mediaUrl, avatar_url: avatar ? mediaUrl : undefined, cover_image: avatar ? undefined : mediaUrl });
      } catch (error) { db.exec("ROLLBACK"); try { unlinkSync(diskPath); } catch {} throw error; }
    }

    if (req.method === "POST" && url.pathname === "/api/site-media") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "اول وارد حسابت شو." });
      if (!hasAdminPermission(user, "settings.manage")) return json(res, 403, { error: "مجوز مدیریت رسانه‌های سایت را نداری." });
      const { file } = await parseMultipart(req);
      const originalName = String(file.fileName).split(/[\\/]/).pop()?.trim() || "";
      if (!originalName || originalName.length > 180 || /[\u0000-\u001f\u007f]/.test(originalName) || basename(originalName) !== originalName) return json(res, 400, { error: "نام فایل معتبر نیست." });
      const { mimeType, extension } = inspectUpload(file);
      if (!mimeType.startsWith("image/")) return json(res, 415, { error: "برای رسانه سایت فقط JPG یا PNG انتخاب کن." });
      const storedName = `${randomBytes(24).toString("hex")}${extension}`;
      const diskPath = resolve(uploadsDirectory, storedName);
      writeFileSync(diskPath, file.buffer, { flag: "wx", mode: 0o600 });
      try {
        const result = db.prepare("INSERT INTO documents(owner_id,kind,file_name,path,mime_type,size_bytes,status) VALUES(?,?,?,?,?,?,'approved')").run(user.id, "site_media", originalName, `data/uploads/${storedName}`, mimeType, file.buffer.length);
        const mediaUrl = `/api/media/${result.lastInsertRowid}`;
        return json(res, 201, { ok: true, url: mediaUrl, media_url: mediaUrl });
      } catch (error) {
        try { unlinkSync(diskPath); } catch {}
        throw error;
      }
    }

    const mediaDownload = /^\/api\/media\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && mediaDownload) {
      const media = db.prepare("SELECT * FROM documents WHERE id=? AND kind IN ('avatar','article_cover','site_media') AND status='approved'").get(Number(mediaDownload[1]));
      const diskPath = media && safeDiskPath(media.path);
      if (!diskPath || !existsSync(diskPath) || !["image/png", "image/jpeg"].includes(media.mime_type)) return json(res, 404, { error: "عکس پیدا نشد." });
      const contents = readFileSync(diskPath);
      res.writeHead(200, { "Content-Type": media.mime_type, "Content-Length": String(contents.length), "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
      return res.end(contents);
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
      const allowedKinds = new Set(["general", "identity", "identity_card", "license", "bar_license", "case", "contract", "evidence", "question", "consultation"]);
      if (!allowedKinds.has(requestedKind)) return json(res, 400, { error: "نوع مدرک رو از گزینه‌های موجود انتخاب کن." });
      const kind = requestedKind;
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
        if (!question || question.client_id !== user.id && !assigned) return json(res, 403, { error: "به این پرسش دسترسی ندارید" });
        linkedLawyerId = question.lawyer_id ?? linkedLawyerId;
      }
      const storedName = `${randomBytes(24).toString("hex")}${extension}`;
      const diskPath = resolve(uploadsDirectory, storedName);
      if (!safeDiskPath(`data/uploads/${storedName}`)) return json(res, 400, { error: "مسیر فایل معتبر نیست" });
      writeFileSync(diskPath, file.buffer, { flag: "wx", mode: 0o600 });
      try {
        const result = db.prepare("INSERT INTO documents(owner_id,lawyer_id,question_id,consultation_id,kind,file_name,path,mime_type,size_bytes,status) VALUES(?,?,?,?,?,?,?,?,?,?)").run(user.id, linkedLawyerId, questionId, consultationId, kind, originalName, `data/uploads/${storedName}`, mimeType, file.buffer.length, questionId || consultationId ? "approved" : "pending");
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
        if (db.prepare("SELECT COUNT(*) count FROM questions WHERE client_id=?").get(user.id).count >= settingNumber("free_question_limit", 3)) throw new ApiError(409, "سهم پرسش رایگانت تموم شده. می‌تونی مشاوره پولی بگیری.");
        const assignedIds = lawyerId ? [lawyerId] : db.prepare("SELECT l.id FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.verified=1 AND u.status='active' ORDER BY l.featured DESC,l.rating DESC,l.id LIMIT ?").all(answerLimit()).map((row) => row.id);
        const result = db.prepare("INSERT INTO questions(client_id,lawyer_id,topic,body,kind,status,publish_allowed,urgent) VALUES(?,?,?,?,?,?,?,?)").run(user.id, lawyerId, topic, questionBody, lawyerId ? "direct" : "public", lawyerId ? "assigned" : "pending_assignment", body.publishAllowed === true ? 1 : 0, body.urgent === true ? 1 : 0);
        for (const assignedId of assignedIds) db.prepare("INSERT INTO question_assignments(question_id,lawyer_id,status) VALUES(?,?,'assigned')").run(result.lastInsertRowid, assignedId);
        const status = assignedIds.length ? "assigned" : "pending_assignment";
        db.prepare("UPDATE questions SET status=? WHERE id=?").run(status, result.lastInsertRowid);
        db.exec("COMMIT");
        return json(res, 201, { ok: true, id: Number(result.lastInsertRowid), status, assignedLawyerIds: assignedIds });
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
      const description = body.description == null || body.description === "" ? null : validText(body.description, 1, 4000);
      if (!["phone", "in_person", "text"].includes(type)) return json(res, 400, { error: "نوع مشاوره رو درست انتخاب کن." });
      if (!topic) return json(res, 400, { error: "موضوع مشاوره معتبر لازم است" });
      if (body.description != null && body.description !== "" && !description) return json(res, 400, { error: "شرح درخواست باید حداکثر ۴۰۰۰ نویسه باشه." });
      if (type === "in_person" && db.prepare("SELECT value FROM settings WHERE key='global_in_person_enabled'").get()?.value === "0") return json(res, 503, { error: "مشاوره حضوری موقتاً غیرفعال است" });
      let lawyerId = body.lawyerId == null || body.lawyerId === "" ? null : validId(body.lawyerId);
      const slotId = type === "in_person" && body.slotId != null && body.slotId !== "" ? validId(body.slotId) : null;
      if (body.lawyerId != null && body.lawyerId !== "" && !lawyerId || body.slotId != null && body.slotId !== "" && !slotId) return json(res, 400, { error: "شناسه وکیل یا زمان انتخابی معتبر نیست" });
      let selectedSlot = null;
      if (type === "in_person") {
        if (!slotId) return json(res, 400, { error: "برای مشاوره حضوری یک زمان آزاد انتخاب کن." });
        selectedSlot = db.prepare(`SELECT s.* FROM appointment_slots s
          JOIN lawyers l ON l.id=s.lawyer_id JOIN users u ON u.id=l.user_id
          WHERE s.id=? AND s.consultation_type='in_person' AND s.status='available'
          AND datetime(s.starts_at)>datetime('now') AND l.verified=1 AND l.in_person_enabled=1 AND u.status='active'`).get(slotId);
        if (!selectedSlot) return json(res, 409, { error: "این زمان حضوری دیگه در دسترس نیست." });
        if (lawyerId && lawyerId !== selectedSlot.lawyer_id) return json(res, 400, { error: "زمان انتخابی به این وکیل تعلق نداره." });
        lawyerId = selectedSlot.lawyer_id;
      }
      let lawyer = lawyerId ? db.prepare("SELECT l.* FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.id=? AND l.verified=1 AND u.status='active'").get(lawyerId) : null;
      if (lawyerId && !lawyer) return json(res, 400, { error: "وکیل انتخاب‌شده معتبر یا تأییدشده نیست" });
      if (type === "text" && !lawyer) {
        const defaultTextPrice = settingNumber("default_text_price", 200000);
        lawyer = db.prepare("SELECT l.* FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.verified=1 AND u.status='active' ORDER BY l.rating DESC,l.featured DESC,l.online DESC,l.id")
          .all()
          .find((candidate) => priceAllowed("text", Number(candidate.text_price || defaultTextPrice)));
        if (!lawyer) return json(res, 409, { error: "فعلاً وکیل آماده‌ای برای مشاوره متنی پیدا نشد." });
        lawyerId = lawyer.id;
      }
      const sourceQuestionId = body.sourceQuestionId ? validId(body.sourceQuestionId) : null;
      if (body.sourceQuestionId && !sourceQuestionId) return json(res, 400, { error: "پرسش اصلی رو درست انتخاب کن." });
      if (sourceQuestionId && (type !== "text" || !db.prepare("SELECT 1 FROM questions q JOIN answers a ON a.question_id=q.id WHERE q.id=? AND q.client_id=? AND a.lawyer_id=?").get(sourceQuestionId, user.id, lawyerId))) return json(res, 403, { error: "این ادامه مشاوره به پرسش و وکیل انتخابی مرتبط نیست." });
      if (type === "in_person" && (!lawyer.in_person_enabled || !lawyer.in_person_price)) return json(res, 400, { error: "مشاوره حضوری برای این وکیل فعال نیست" });
      let scheduledAt = selectedSlot ? new Date(selectedSlot.starts_at).toISOString() : null;
      const defaultPrice = settingNumber(`default_${type}_price`, type === "text" ? 200000 : 0);
      const amount = Number(lawyer ? lawyer[`${type}_price`] || defaultPrice : defaultPrice);
      const commissionRate = Number(db.prepare("SELECT value FROM settings WHERE key='site_commission'").get()?.value || 0);
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000 || !Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100) return json(res, 409, { error: "تعرفه معتبر برای این مشاوره ثبت نشده است" });
      const commissionAmount = Math.round(amount * commissionRate / 100);
      const trackingCode = `DR-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
      const deferPayment = body.deferPayment === true;
      const status = deferPayment ? "pending_payment" : type === "phone" ? "pending_coordination" : type === "text" ? "confirmed" : lawyer ? "registered" : "pending_assignment";
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
        const result = db.prepare("INSERT INTO consultations(client_id,lawyer_id,slot_id,type,topic,description,scheduled_at,amount,payment_status,status,source_question_id,message_limit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(user.id, lawyerId, slotId, type, topic, description, scheduledAt, amount, paymentStatus, status, sourceQuestionId, settingNumber("text_message_limit", 3));
        consultationId = Number(result.lastInsertRowid);
        db.prepare("INSERT INTO orders(client_id,consultation_id,type,amount,commission_rate,commission_amount,status,tracking_code,paid_at) VALUES(?,?,?,?,?,?,?,?,CASE WHEN ?='paid' THEN CURRENT_TIMESTAMP ELSE NULL END)").run(user.id, consultationId, type, amount, commissionRate, commissionAmount, orderStatus, trackingCode, orderStatus);
        if (type === "text" && !deferPayment) ensureConversation(db.prepare("SELECT * FROM consultations WHERE id=?").get(consultationId));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(res, 201, {
        ok: true,
        id: consultationId,
        lawyerId,
        amount,
        commissionRate,
        status,
        trackingCode,
        paymentStatus,
        paymentRequired: deferPayment,
        checkoutPath: deferPayment ? `/api/checkout/${trackingCode}` : null,
        scheduledAt,
        message: type === "phone" ? "پشتیبانی برای هماهنگی زمان مشاوره باهات تماس می‌گیره. بعد از هماهنگی، زمانش رو توی پنلت می‌بینی." : null,
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
            const nextStatus = checkout.consultation.type === "phone" ? "pending_coordination" : checkout.consultation.type === "text" ? "confirmed" : checkout.consultation.lawyerId ? "registered" : "pending_assignment";
            const paid = db.prepare("UPDATE orders SET status='paid',paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(checkout.order.id);
            const confirmed = db.prepare("UPDATE consultations SET payment_status='simulated_paid',status=? WHERE id=? AND status='pending_payment' AND payment_status='pending'").run(nextStatus, checkout.consultation.id);
            if (!paid.changes || !confirmed.changes) throw new ApiError(409, "وضعیت پرداخت هم‌زمان تغییر کرده است");
            if (checkout.consultation.type === "text") ensureConversation(db.prepare("SELECT * FROM consultations WHERE id=?").get(checkout.consultation.id));
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
        if (!["pending_assignment", "pending_coordination", "registered", "confirmed"].includes(consultation.status)) return json(res, 409, { error: "این مشاوره در وضعیت فعلی قابل لغو نیست" });
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
          pending_coordination: ["cancelled"],
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
      const consultation = db.prepare("SELECT * FROM consultations WHERE id=?").get(conversation.consultation_id);
      if (consultation?.type !== "text") return json(res, 409, { error: "این مشاوره متنی نیست و گفت‌وگوی چتی نداره." });
      if (conversation.status !== "open" || !["confirmed", "in_progress"].includes(consultation?.status)) return json(res, 409, { error: "این گفت‌وگو بسته است" });
      const messageBody = validText(body.body, 1, 4000);
      if (!messageBody) return json(res, 400, { error: "متن پیام باید بین ۱ تا ۴۰۰۰ نویسه باشد" });
      let result;
      let usageAfter;
      let conversationStatus = conversation.status;
      db.exec("BEGIN IMMEDIATE");
      try {
        const liveConversation = db.prepare("SELECT * FROM conversations WHERE id=?").get(conversation.id);
        const liveConsultation = db.prepare("SELECT * FROM consultations WHERE id=? AND type='text'").get(conversation.consultation_id);
        if (liveConversation?.status !== "open" || !["confirmed", "in_progress"].includes(liveConsultation?.status)) throw new ApiError(409, "این گفت‌وگو بسته است");
        const limit = liveConsultation.message_limit || settingNumber("text_message_limit", 3);
        const lawyerUserId = db.prepare("SELECT user_id FROM lawyers WHERE id=?").get(liveConversation.lawyer_id)?.user_id;
        const usageBefore = conversationTurnUsage(liveConversation.id, liveConversation.client_id, lawyerUserId);
        const participant = liveConversation.client_id === user.id ? "client" : "lawyer";
        const startsNewTurn = usageBefore.lastSenderId !== user.id;
        if (startsNewTurn && usageBefore[participant] >= limit) {
          if (usageBefore.client >= limit && usageBefore.lawyer >= limit) {
            db.prepare("UPDATE conversations SET status='closed' WHERE id=?").run(conversation.id);
            db.prepare("UPDATE consultations SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(consultation.id);
            db.exec("COMMIT");
            return json(res, 409, { error: "نوبت‌های این گفت‌وگو تموم شده. برای ادامه یک مشاوره تازه بگیر.", conversation_status: "closed", turn_limit: limit, turn_usage: { client: usageBefore.client, lawyer: usageBefore.lawyer } });
          }
          throw new ApiError(409, "سهم نوبت‌های گفت‌وگوت تموم شده. برای ادامه یک مشاوره تازه بگیر.");
        }
        result = db.prepare("INSERT INTO chat_messages(conversation_id,sender_id,body) VALUES(?,?,?)").run(conversation.id, user.id, messageBody);
        usageAfter = {
          client: usageBefore.client + (startsNewTurn && participant === "client" ? 1 : 0),
          lawyer: usageBefore.lawyer + (startsNewTurn && participant === "lawyer" ? 1 : 0),
        };
        if (usageAfter.client >= limit && usageAfter.lawyer >= limit) {
          db.prepare("UPDATE conversations SET status='closed' WHERE id=?").run(conversation.id);
          db.prepare("UPDATE consultations SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(consultation.id);
          conversationStatus = "closed";
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      const limit = consultation.message_limit || settingNumber("text_message_limit", 3);
      const message = db.prepare("SELECT cm.id,cm.conversation_id,cm.sender_id,cm.body,cm.created_at,u.first_name||' '||u.last_name sender_name,u.role sender_role,COALESCE(u.avatar_url,'/avatars/default-'||u.role||'.png') sender_avatar_url FROM chat_messages cm JOIN users u ON u.id=cm.sender_id WHERE cm.id=?").get(result.lastInsertRowid);
      return json(res, 201, {
        ok: true,
        message,
        conversation_status: conversationStatus,
        turn_limit: limit,
        turn_usage: usageAfter,
        turns_remaining: { client: Math.max(0, limit - usageAfter.client), lawyer: Math.max(0, limit - usageAfter.lawyer) },
        quota_complete: usageAfter.client >= limit && usageAfter.lawyer >= limit,
      });
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
        if (db.prepare("SELECT COUNT(*) count FROM answers WHERE question_id=?").get(questionId).count >= answerLimit()) throw new ApiError(409, "تعداد پاسخ‌های این پرسش به سقف مجاز رسیده.");
        result = db.prepare("INSERT INTO answers(question_id,lawyer_id,body,published) VALUES(?,?,?,?)").run(questionId, lawyer.id, answerBody, question.publish_allowed ? 1 : 0);
        db.prepare("UPDATE question_assignments SET status='answered' WHERE question_id=? AND lawyer_id=?").run(questionId, lawyer.id);
        const remaining = db.prepare("SELECT COUNT(*) count FROM question_assignments WHERE question_id=? AND status='assigned'").get(questionId).count;
        db.prepare("UPDATE questions SET status=? WHERE id=?").run(remaining && db.prepare("SELECT COUNT(*) count FROM answers WHERE question_id=?").get(questionId).count < answerLimit() ? "assigned" : "answered", questionId);
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

    if (req.method === "POST" && url.pathname === "/api/notifications/read") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "اول وارد حسابت شو." });
      const body = await readBody(req);
      if (!Array.isArray(body.ids) || body.ids.length > 200 || body.ids.some((id) => typeof id !== "string" || id.length > 160)) return json(res, 400, { error: "اعلان‌ها معتبر نیستن." });
      const ids = [...new Set([...jsonSetting(`notification_seen_${user.id}`, []), ...body.ids])].slice(-2000);
      db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`notification_seen_${user.id}`, JSON.stringify(ids));
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: "ورود لازم است" });

      if (user.role === "client") {
        const questionRows = db.prepare("SELECT id,lawyer_id,topic,body,kind,status,publish_allowed,urgent,created_at FROM questions WHERE client_id=? ORDER BY created_at DESC").all(user.id);
        const answerStatement = db.prepare("SELECT a.id,a.question_id,a.lawyer_id,a.body,a.published,a.created_at,u.first_name||' '||u.last_name lawyer_name,u.avatar_url lawyer_avatar_url FROM answers a JOIN lawyers l ON l.id=a.lawyer_id JOIN users u ON u.id=l.user_id WHERE a.question_id=? ORDER BY a.created_at");
        const questions = questionRows.map((question) => {
          const answers = answerStatement.all(question.id).slice(0, answerLimit());
          return { ...question, answers, attachments: documentsForQuestion(question.id), closed: question.status === "cancelled" || answers.length > 0 };
        });
        const consultations = db.prepare("SELECT c.*,u.first_name||' '||u.last_name lawyer_name,o.tracking_code,o.status order_status FROM consultations c LEFT JOIN lawyers l ON l.id=c.lawyer_id LEFT JOIN users u ON u.id=l.user_id LEFT JOIN orders o ON o.consultation_id=c.id WHERE c.client_id=? ORDER BY c.created_at DESC").all(user.id)
          .map((consultation) => ({ ...consultation, attachments: documentsForConsultation(consultation.id, user) }));
        const orders = db.prepare("SELECT o.*,c.topic,c.status consultation_status,u.first_name||' '||u.last_name lawyer_name FROM orders o LEFT JOIN consultations c ON c.id=o.consultation_id LEFT JOIN lawyers l ON l.id=c.lawyer_id LEFT JOIN users u ON u.id=l.user_id WHERE o.client_id=? ORDER BY o.created_at DESC").all(user.id);
        const bookmarks = db.prepare("SELECT l.id,l.specialties,l.rating,l.online,l.in_person_enabled,u.first_name||' '||u.last_name name,u.city,b.created_at FROM bookmarks b JOIN lawyers l ON l.id=b.lawyer_id JOIN users u ON u.id=l.user_id WHERE b.client_id=? ORDER BY b.created_at DESC").all(user.id);
        const reviews = db.prepare("SELECT r.*,u.first_name||' '||u.last_name lawyer_name FROM reviews r JOIN lawyers l ON l.id=r.lawyer_id JOIN users u ON u.id=l.user_id WHERE r.client_id=? ORDER BY r.created_at DESC").all(user.id);
        const eligibleReviews = db.prepare("SELECT c.id consultation_id,c.lawyer_id,c.type,c.topic,c.completed_at,u.first_name||' '||u.last_name lawyer_name FROM consultations c JOIN lawyers l ON l.id=c.lawyer_id JOIN users u ON u.id=l.user_id LEFT JOIN reviews r ON r.consultation_id=c.id WHERE c.client_id=? AND c.status='completed' AND r.id IS NULL ORDER BY c.completed_at DESC").all(user.id);
        const messages = db.prepare("SELECT id,name,phone,kind,subject,body,order_code,admin_reply,status,created_at,updated_at FROM messages WHERE user_id=? ORDER BY created_at DESC").all(user.id);
        const conversations = conversationPayloads("client", user.id);
        return json(res, 200, {
          role: "client",
          settings: settingsPayload(),
          freeQuestionsRemaining: Math.max(0, settingNumber("free_question_limit", 3) - questions.length),
          ...notificationPayload(user, { questions, consultations, conversations, messages, documents: documentsForOwner(user.id) }),
          account: accountFor(user.id),
          profile: accountFor(user.id),
          consultations,
          orders,
          questions,
          bookmarks,
          reviews,
          eligibleReviews,
          documents: documentsForOwner(user.id),
          conversations,
          messages,
        });
      }

      if (user.role === "lawyer") {
        const lawyer = lawyerForUser(user.id);
        if (!lawyer) return json(res, 404, { error: "پروفایل وکیل پیدا نشد" });
        const profile = db.prepare("SELECT l.*,u.username,u.first_name,u.last_name,u.email,u.phone,u.province,u.city,u.status,u.avatar_url,u.created_at FROM lawyers l JOIN users u ON u.id=l.user_id WHERE l.id=?").get(lawyer.id);
        profile.specialty_ids = specialtyIdsForLawyer(lawyer.id);
        const services = db.prepare(`SELECT s.*,
          EXISTS(SELECT 1 FROM lawyer_specialties ls WHERE ls.service_id=s.id AND ls.lawyer_id=?) selected
          FROM services s
          WHERE s.active=1 OR EXISTS(SELECT 1 FROM lawyer_specialties ls WHERE ls.service_id=s.id AND ls.lawyer_id=?)
          ORDER BY s.sort_order,s.id`).all(lawyer.id, lawyer.id);
        const consultations = db.prepare("SELECT c.*,u.first_name||' '||u.last_name client_name,u.phone client_phone,o.tracking_code,o.status order_status FROM consultations c LEFT JOIN users u ON u.id=c.client_id LEFT JOIN orders o ON o.consultation_id=c.id WHERE c.lawyer_id=? ORDER BY c.created_at DESC").all(lawyer.id)
          .map((consultation) => ({ ...consultation, attachments: documentsForConsultation(consultation.id, user) }));
        const lawyerQuestionRows = db.prepare("SELECT q.id,q.client_id,q.lawyer_id,q.topic,q.body,q.kind,q.status,q.publish_allowed,q.urgent,q.created_at,qa.status assignment_status,qa.assigned_at,u.first_name||' '||u.last_name client_name,u.avatar_url client_avatar_url FROM question_assignments qa JOIN questions q ON q.id=qa.question_id JOIN users u ON u.id=q.client_id WHERE qa.lawyer_id=? AND (qa.status IN ('assigned','answered') OR (q.status='cancelled' AND qa.status='withdrawn')) ORDER BY q.created_at DESC").all(lawyer.id);
        const lawyerAnswerStatement = db.prepare("SELECT a.id,a.question_id,a.lawyer_id,a.body,a.published,a.created_at,u.first_name||' '||u.last_name lawyer_name,u.avatar_url lawyer_avatar_url FROM answers a JOIN lawyers l ON l.id=a.lawyer_id JOIN users u ON u.id=l.user_id WHERE a.question_id=? AND a.lawyer_id=? ORDER BY a.created_at");
        const questions = lawyerQuestionRows.map((question) => ({
          ...question,
          answers: lawyerAnswerStatement.all(question.id, lawyer.id),
          attachments: question.status === "cancelled" ? [] : documentsForQuestion(question.id),
        }));
        const slots = db.prepare("SELECT id,lawyer_id,starts_at,ends_at,consultation_type,status FROM appointment_slots WHERE lawyer_id=? ORDER BY starts_at DESC").all(lawyer.id);
        const reviews = db.prepare("SELECT r.*,u.first_name||' '||substr(u.last_name,1,1)||'.' client_name FROM reviews r LEFT JOIN users u ON u.id=r.client_id WHERE r.lawyer_id=? ORDER BY r.created_at DESC").all(lawyer.id);
        const orders = db.prepare("SELECT o.*,c.topic,c.status consultation_status,u.first_name||' '||u.last_name client_name,(o.amount-o.commission_amount) net_amount FROM orders o JOIN consultations c ON c.id=o.consultation_id LEFT JOIN users u ON u.id=c.client_id WHERE c.lawyer_id=? ORDER BY o.created_at DESC").all(lawyer.id);
        const articles = db.prepare("SELECT * FROM articles WHERE author_user_id=? ORDER BY created_at DESC").all(user.id);
        const conversations = conversationPayloads("lawyer", lawyer.id);
        return json(res, 200, {
          role: "lawyer",
          settings: settingsPayload(),
          articles,
          ...notificationPayload(user, { profile, questions, consultations, reviews, articles, conversations, documents: documentsForLawyer(lawyer) }),
          account: accountFor(user.id),
          profile,
          services,
          consultations,
          questions,
          slots,
          reviews,
          orders,
          documents: documentsForLawyer(lawyer),
          conversations,
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
          data.consultations = db.prepare("SELECT c.*,cu.first_name||' '||cu.last_name client_name,lu.first_name||' '||lu.last_name lawyer_name,o.tracking_code,o.status order_status FROM consultations c LEFT JOIN users cu ON cu.id=c.client_id LEFT JOIN lawyers l ON l.id=c.lawyer_id LEFT JOIN users lu ON lu.id=l.user_id LEFT JOIN orders o ON o.consultation_id=c.id ORDER BY c.created_at DESC").all()
            .map((consultation) => ({ ...consultation, attachments: documentsForConsultation(consultation.id, user) }));
          if (can("consultations.manage")) data.pendingConsultations = data.consultations.filter((consultation) => ["pending_assignment", "pending_coordination", "registered"].includes(consultation.status));
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
          data.documents = db.prepare("SELECT d.*,u.first_name||' '||u.last_name owner_name,lu.first_name||' '||lu.last_name lawyer_name FROM documents d JOIN users u ON u.id=d.owner_id LEFT JOIN lawyers l ON l.id=d.lawyer_id LEFT JOIN users lu ON lu.id=l.user_id WHERE d.consultation_id IS NULL AND d.question_id IS NULL AND d.kind<>'site_media' ORDER BY d.created_at DESC").all().map(publicDocument);
        }
        if (can("content.manage")) {
          data.articles = db.prepare("SELECT * FROM articles ORDER BY created_at DESC").all();
          data.faqs = db.prepare("SELECT * FROM faqs ORDER BY sort_order,id").all();
        }
        if (can("services.manage")) data.services = db.prepare(`SELECT s.*,COUNT(ls.id) lawyer_count
          FROM services s LEFT JOIN lawyer_specialties ls ON ls.service_id=s.id
          GROUP BY s.id ORDER BY s.sort_order,s.id`).all();
        if (can("settings.manage")) {
          data.settings = Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key NOT IN ('primary_admin_id','primary_admin_username') ORDER BY key").all().map((setting) => [setting.key, setting.value]));
        }
        if (can("admins.manage")) {
          data.admins = db.prepare("SELECT id,username,first_name,last_name,email,phone,status,created_at FROM users WHERE role='admin' ORDER BY created_at").all();
          data.permissions = db.prepare("SELECT admin_id,permission,allowed FROM admin_permissions ORDER BY admin_id,permission").all();
          data.permissionNames = permissionNames;
        }
        if (can("lawyers.verify") || can("consultations.manage")) data.slots = db.prepare("SELECT s.*,u.first_name||' '||u.last_name lawyer_name FROM appointment_slots s JOIN lawyers l ON l.id=s.lawyer_id JOIN users u ON u.id=l.user_id ORDER BY s.starts_at DESC").all();
        return json(res, 200, { ...data, ...notificationPayload(user, data) });
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

      if (action === "cancel-question") {
        if (!hasAdminPermission(user, "questions.assign")) return json(res, 403, { error: "مجوز لغو پرسش را نداری." });
        const questionId = validId(body.id ?? body.questionId);
        if (!questionId) return json(res, 400, { error: "شناسه پرسش معتبر نیست." });
        const question = db.prepare("SELECT * FROM questions WHERE id=?").get(questionId);
        if (!question) return json(res, 404, { error: "پرسش پیدا نشد." });
        if (question.status === "cancelled") return json(res, 200, { ok: true, idempotent: true, status: "cancelled", withdrawn: 0 });
        let withdrawn = 0;
        db.exec("BEGIN IMMEDIATE");
        try {
          const cancelled = db.prepare("UPDATE questions SET status='cancelled' WHERE id=? AND status<>'cancelled'").run(question.id);
          if (!cancelled.changes) {
            db.exec("ROLLBACK");
            return json(res, 200, { ok: true, idempotent: true, status: "cancelled", withdrawn: 0 });
          }
          withdrawn = db.prepare("UPDATE question_assignments SET status='withdrawn' WHERE question_id=? AND status='assigned'").run(question.id).changes;
          db.prepare("UPDATE answers SET published=0 WHERE question_id=?").run(question.id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return json(res, 200, { ok: true, idempotent: false, status: "cancelled", withdrawn });
      }

      if (action === "assign-question") {
        if (!hasAdminPermission(user, "questions.assign")) return json(res, 403, { error: "مجوز ارجاع پرسش را ندارید" });
        const questionId = validId(body.id ?? body.questionId);
        const requestedIds = Array.isArray(body.lawyerIds) ? [...new Set(body.lawyerIds.map(validId).filter(Boolean))] : [];
        if (!questionId || !requestedIds.length || requestedIds.length > answerLimit()) return json(res, 400, { error: `برای این پرسش حداکثر ${answerLimit()} وکیل انتخاب کن.` });
        const question = db.prepare("SELECT * FROM questions WHERE id=?").get(questionId);
        if (!question || ["cancelled"].includes(question.status)) return json(res, 404, { error: "پرسش قابل ارجاع پیدا نشد" });
        const answeredIds = db.prepare("SELECT lawyer_id FROM answers WHERE question_id=?").all(questionId).map((row) => row.lawyer_id);
        if (new Set([...requestedIds, ...answeredIds]).size > answerLimit()) return json(res, 409, { error: "با احتساب وکلایی که پاسخ دادن، تعداد از سقف مجاز بیشتر می‌شه." });
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

      if (action === "schedule-phone") {
        if (!hasAdminPermission(user, "consultations.manage")) return json(res, 403, { error: "به مدیریت مشاوره دسترسی نداری." });
        const consultationId = validId(body.id ?? body.consultationId);
        const slotId = validId(body.slotId);
        const consultation = db.prepare("SELECT * FROM consultations WHERE id=? AND type='phone'").get(consultationId);
        if (!consultation || !["pending_coordination", "registered", "confirmed"].includes(consultation.status) || consultation.payment_status !== "simulated_paid") return json(res, 409, { error: "این مشاوره فعلاً قابل زمان‌بندی نیست." });
        db.exec("BEGIN IMMEDIATE");
        try {
          const slot = db.prepare("SELECT s.* FROM appointment_slots s JOIN lawyers l ON l.id=s.lawyer_id JOIN users u ON u.id=l.user_id WHERE s.id=? AND s.consultation_type='phone' AND s.status='available' AND datetime(s.starts_at)>datetime('now') AND l.verified=1 AND u.status='active'").get(slotId);
          if (!slot || body.lawyerId && slot.lawyer_id !== validId(body.lawyerId)) throw new ApiError(409, "این زمان آزاد تلفنی در دسترس نیست.");
          releaseBookedSlot(consultation);
          db.prepare("UPDATE appointment_slots SET status='booked' WHERE id=?").run(slot.id);
          db.prepare("UPDATE consultations SET lawyer_id=?,slot_id=?,scheduled_at=?,status='confirmed' WHERE id=?").run(slot.lawyer_id, slot.id, slot.starts_at, consultation.id);
          db.prepare("UPDATE documents SET lawyer_id=? WHERE consultation_id=?").run(slot.lawyer_id, consultation.id);
          db.prepare("UPDATE conversations SET status='closed' WHERE consultation_id=?").run(consultation.id);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        return json(res, 200, { ok: true, consultation: db.prepare("SELECT * FROM consultations WHERE id=?").get(consultation.id) });
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
        if (document.kind === "site_media") return json(res, 409, { error: "رسانه‌های لوگو و اسلایدر فقط از تنظیمات سایت مدیریت می‌شن." });
        const diskPath = safeDiskPath(document.path);
        if (diskPath && existsSync(diskPath)) unlinkSync(diskPath);
        db.prepare("DELETE FROM documents WHERE id=?").run(document.id);
        return json(res, 200, { ok: true });
      }

      if (action === "service-save") {
        if (!hasAdminPermission(user, "services.manage")) return json(res, 403, { error: "مجوز مدیریت خدمات را ندارید" });
        const serviceIdProvided = body.id !== undefined && body.id !== null && body.id !== "";
        const serviceId = serviceIdProvided ? validId(body.id) : null;
        if (serviceIdProvided && !serviceId) return json(res, 400, { error: "شناسه حوزه تخصصی معتبر نیست" });
        const existingService = serviceId ? db.prepare("SELECT * FROM services WHERE id=?").get(serviceId) : null;
        const title = validText(body.title, 2, 120);
        const description = validText(body.description, 5, 1000);
        const backDescription = validText(body.backDescription ?? body.back_description ?? existingService?.back_description ?? description, 5, 1600);
        const caseTypes = validTextList(body.caseTypes ?? body.case_types ?? existingService?.case_types ?? []);
        const icon = /^[a-z0-9-]{2,40}$/.test(cleanText(body.icon)) ? cleanText(body.icon) : "scale";
        const sortOrder = Number(body.sortOrder ?? 0);
        const active = body.active === false ? 0 : 1;
        if (!title || !description || !backDescription || !caseTypes || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 10000) return json(res, 400, { error: "اطلاعات حوزه تخصصی معتبر نیست؛ متن پشت کارت و حداکثر ۱۲ نمونه پرونده را بررسی کن." });
        try {
          if (serviceId) {
            const changed = db.prepare("UPDATE services SET title=?,description=?,back_description=?,case_types=?,icon=?,active=?,sort_order=? WHERE id=?").run(title, description, backDescription, JSON.stringify(caseTypes), icon, active, sortOrder, serviceId);
            if (!changed.changes) return json(res, 404, { error: "خدمت پیدا نشد" });
            for (const { lawyer_id: lawyerId } of db.prepare("SELECT lawyer_id FROM lawyer_specialties WHERE service_id=?").all(serviceId)) refreshLawyerSpecialtyCache(lawyerId);
          } else {
            db.prepare("INSERT INTO services(title,description,back_description,case_types,icon,active,sort_order) VALUES(?,?,?,?,?,?,?)").run(title, description, backDescription, JSON.stringify(caseTypes), icon, active, sortOrder);
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
        if (!serviceId) return json(res, 400, { error: "شناسه حوزه تخصصی معتبر نیست" });
        const linkedLawyers = db.prepare("SELECT COUNT(*) count FROM lawyer_specialties WHERE service_id=?").get(serviceId)?.count || 0;
        if (linkedLawyers) return json(res, 409, { error: `این حوزه هنوز برای ${linkedLawyers} وکیل انتخاب شده؛ فعلاً غیرفعالش کن یا اول تخصص وکلا رو تغییر بده.` });
        if (!db.prepare("DELETE FROM services WHERE id=?").run(serviceId).changes) return json(res, 404, { error: "حوزه تخصصی پیدا نشد" });
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
        if (["default_phone_price", "default_in_person_price", "default_text_price"].includes(key) || /^(phone|text|in_person)_price_(min|max)$/.test(key)) {
          const number = Number(value);
          if (!Number.isSafeInteger(number) || number <= 0 || number > 100000000) return json(res, 400, { error: "تعرفه معتبر نیست" });
          value = String(number);
          const range = /^(phone|text|in_person)_price_(min|max)$/.exec(key);
          if (range) {
            const other = settingNumber(`${range[1]}_price_${range[2] === "min" ? "max" : "min"}`, range[2] === "min" ? 100000000 : 1);
            if (range[2] === "min" ? number > other : number < other) return json(res, 400, { error: "حداقل نرخ نمی‌تونه از حداکثر بیشتر باشه." });
          }
        } else if (["free_question_limit", "max_question_lawyers", "text_message_limit"].includes(key)) {
          const number = Number(value);
          if (!Number.isSafeInteger(number) || number < 1 || number > 100) return json(res, 400, { error: "یک عدد بین ۱ تا ۱۰۰ وارد کن." });
          value = String(number);
        } else if (key === "hero_images") {
          if (value.length > 4000) return json(res, 400, { error: "فهرست تصاویر اصلی خیلی طولانیه." });
          let parsed;
          try { parsed = JSON.parse(value); } catch { return json(res, 400, { error: "فهرست تصاویر اصلی معتبر نیست." }); }
          if (!Array.isArray(parsed) || parsed.length > 8 || parsed.some((item) => typeof item !== "string")) return json(res, 400, { error: "حداکثر ۸ تصویر معتبر انتخاب کن." });
          const mediaUrls = [...new Set(parsed.map((item) => cleanText(item)))];
          if (mediaUrls.some((item) => !isStoredSiteMediaUrl(item))) return json(res, 400, { error: "یکی از تصاویر انتخاب‌شده معتبر نیست." });
          value = JSON.stringify(mediaUrls);
        } else if (["logo_light_url", "logo_dark_url", "favicon_url"].includes(key)) {
          if (value && !isStoredSiteMediaUrl(value)) return json(res, 400, { error: "رسانه انتخاب‌شده معتبر نیست." });
        } else if (["footer_config", "trust_items", "article_tags", "stat_labels"].includes(key)) {
          if (value.length > 30000) return json(res, 400, { error: "این محتوا خیلی طولانیه." });
          let parsed;
          try { parsed = JSON.parse(value); } catch { return json(res, 400, { error: "ساختار محتوا معتبر نیست." }); }
          if (["trust_items", "article_tags"].includes(key) && !Array.isArray(parsed) || ["footer_config", "stat_labels"].includes(key) && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) return json(res, 400, { error: "ساختار محتوا معتبر نیست." });
          if (key === "article_tags" && (parsed.length > 100 || parsed.some((tag) => typeof tag !== "string" || tag.length < 1 || tag.length > 80))) return json(res, 400, { error: "تگ‌ها باید متن کوتاه باشن." });
          value = JSON.stringify(parsed);
        } else if (["terms_content", "privacy_content"].includes(key)) {
          if (!value || value.length > 50000) return json(res, 400, { error: "متن قوانین باید بین ۱ تا ۵۰۰۰۰ نویسه باشه." });
        } else if (key === "site_views") {
          if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) return json(res, 400, { error: "آمار بازدید باید یک عدد مثبت یا صفر باشه." });
        } else if (key === "site_commission") {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0 || number > 100) return json(res, 400, { error: "درصد کمیسیون باید بین صفر تا صد باشد" });
          value = String(number);
        } else if (["questions_enabled", "global_in_person_enabled", "maintenance_mode", "stats_enabled", "trust_enabled"].includes(key)) {
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
      if (!user || user.role !== "lawyer" && !hasAdminPermission(user, "content.manage")) return json(res, 403, { error: "برای نوشتن مقاله وارد حساب وکیل یا مدیر شو." });
      const action = cleanText(body.action || "save");
      const articleId = body.id ? validId(body.id) : null;
      const existing = articleId ? db.prepare("SELECT * FROM articles WHERE id=?").get(articleId) : null;
      if (articleId && !existing) return json(res, 404, { error: "مقاله پیدا نشد." });
      if (existing && user.role === "lawyer" && existing.author_user_id !== user.id) return json(res, 403, { error: "فقط مقاله‌های خودت رو می‌تونی ویرایش کنی." });
      if (action === "delete") {
        if (!articleId || !db.prepare("DELETE FROM articles WHERE id=?").run(articleId).changes) return json(res, 404, { error: "مقاله پیدا نشد" });
        return json(res, 200, { ok: true });
      }
      const slug = cleanText(body.slug).toLowerCase();
      const title = validText(body.title, 3, 220);
      const excerpt = validText(body.excerpt, 10, 1000);
      const articleBody = validText(body.body, 20, 30000);
      const author = validText(user.role === "lawyer" ? user.first_name + " " + user.last_name : body.author || user.first_name + " " + user.last_name, 2, 160);
      const publish = user.role === "admin" && (body.publish === true || cleanText(body.status) === "published");
      const status = user.role === "lawyer" ? "pending_review" : publish ? "published" : "draft";
      const tags = body.tags === undefined ? JSON.parse(existing?.tags || "[]") : body.tags;
      const allowedTags = jsonSetting("article_tags", []);
      if (!Array.isArray(tags) || tags.length < 1 || tags.length > 20 || tags.some((tag) => typeof tag !== "string" || !allowedTags.includes(tag))) return json(res, 400, { error: "حداقل یک تگ و حداکثر ۲۰ تگ از فهرستی که مدیر تعیین کرده انتخاب کن." });
      const category = tags[0] || "عمومی";
      const coverImage = cleanText(body.coverImage ?? body.cover_image ?? existing?.cover_image ?? "");
      const uploadedCover = /^\/api\/media\/(\d+)$/.exec(coverImage);
      if (coverImage && (uploadedCover ? !db.prepare("SELECT 1 FROM documents WHERE id=? AND kind='article_cover' AND status='approved' AND (owner_id=? OR ?=1)").get(Number(uploadedCover[1]), user.id, user.role === "admin" ? 1 : 0) : !/^\/blog\/covers\/[a-z0-9-]+\.(webp|png|jpg)$/.test(coverImage))) return json(res, 400, { error: "عکس مقاله رو از بخش بارگذاری انتخاب کن." });
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 160 || !title || !excerpt || !articleBody || !category || !author) return json(res, 400, { error: "عنوان، نشانی انگلیسی، خلاصه و متن معتبر لازم است" });
      try {
        if (articleId) {
          const changed = db.prepare("UPDATE articles SET slug=?,title=?,excerpt=?,body=?,category=?,author=?,status=?,published_at=?,cover_image=?,tags=? WHERE id=?").run(slug, title, excerpt, articleBody, category, author, status, publish ? new Date().toISOString() : null, coverImage || null, JSON.stringify(tags), articleId);
          if (!changed.changes) return json(res, 404, { error: "مقاله پیدا نشد" });
        } else {
          db.prepare("INSERT INTO articles(slug,title,excerpt,body,category,author,status,published_at,cover_image,tags,author_user_id,author_avatar) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(slug, title, excerpt, articleBody, category, author, status, publish ? new Date().toISOString() : null, coverImage || null, JSON.stringify(tags), user.id, accountFor(user.id).avatar_url);
        }
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "نشانی انگلیسی مقاله تکراری است" });
        throw error;
      }
      return json(res, 200, { ok: true, status });
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
