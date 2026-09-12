import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const currentTimestamp = sql`CURRENT_TIMESTAMP`;

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["client", "lawyer", "admin"] }).notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull().unique(),
    phone: text("phone").notNull(),
    avatarUrl: text("avatar_url"),
    province: text("province"),
    city: text("city"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    check(
      "users_role_check",
      sql`${table.role} IN ('client', 'lawyer', 'admin')`,
    ),
  ],
);

export const lawyers = sqliteTable("lawyers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  licenseNumber: text("license_number").notNull(),
  specialties: text("specialties").notNull(),
  bio: text("bio").notNull(),
  phonePrice: integer("phone_price").notNull(),
  textPrice: integer("text_price").notNull().default(0),
  inPersonPrice: integer("in_person_price"),
  rating: real("rating").notNull().default(0),
  verified: integer("verified").notNull().default(0),
  profileCompleted: integer("profile_completed").notNull().default(0),
  featured: integer("featured").notNull().default(0),
  online: integer("online").notNull().default(0),
  inPersonEnabled: integer("in_person_enabled").notNull().default(0),
});

export const questions = sqliteTable(
  "questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clientId: integer("client_id").references(() => users.id),
    lawyerId: integer("lawyer_id").references(() => lawyers.id),
    topic: text("topic").notNull(),
    body: text("body").notNull(),
    kind: text("kind").notNull().default("public"),
    status: text("status").notNull().default("new"),
    publishAllowed: integer("publish_allowed").notNull().default(0),
    urgent: integer("urgent").notNull().default(0),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [index("questions_status_idx").on(table.status)],
);

export const questionAssignments = sqliteTable(
  "question_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    questionId: integer("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    lawyerId: integer("lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
    assignedBy: integer("assigned_by").references(() => users.id),
    status: text("status").notNull().default("assigned"),
    assignedAt: text("assigned_at").notNull().default(currentTimestamp),
  },
  (table) => [
    unique("question_assignments_question_lawyer_unique").on(
      table.questionId,
      table.lawyerId,
    ),
    index("question_assignments_lawyer_idx").on(table.lawyerId, table.status),
    index("question_assignments_question_idx").on(table.questionId),
  ],
);

export const answers = sqliteTable("answers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  questionId: integer("question_id")
    .notNull()
    .references(() => questions.id, { onDelete: "cascade" }),
  lawyerId: integer("lawyer_id")
    .notNull()
    .references(() => lawyers.id),
  body: text("body").notNull(),
  published: integer("published").notNull().default(0),
  createdAt: text("created_at").notNull().default(currentTimestamp),
});

export const appointmentSlots = sqliteTable(
  "appointment_slots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lawyerId: integer("lawyer_id")
      .notNull()
      .references(() => lawyers.id),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    consultationType: text("consultation_type").notNull().default("phone"),
    status: text("status").notNull().default("available"),
  },
  (table) => [
    index("appointment_slots_lawyer_idx").on(table.lawyerId, table.startsAt),
  ],
);

export const consultations = sqliteTable(
  "consultations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clientId: integer("client_id").references(() => users.id),
    lawyerId: integer("lawyer_id").references(() => lawyers.id),
    slotId: integer("slot_id").references(() => appointmentSlots.id),
    sourceQuestionId: integer("source_question_id").references(() => questions.id),
    messageLimit: integer("message_limit").notNull().default(3),
    type: text("type").notNull(),
    topic: text("topic").notNull(),
    description: text("description"),
    scheduledAt: text("scheduled_at"),
    urgent: integer("urgent").notNull().default(0),
    baseAmount: integer("base_amount").notNull().default(0),
    urgentSurchargeRate: real("urgent_surcharge_rate").notNull().default(0),
    urgentSurchargeAmount: integer("urgent_surcharge_amount").notNull().default(0),
    amount: integer("amount").notNull().default(0),
    paymentStatus: text("payment_status")
      .notNull()
      .default("simulated_paid"),
    status: text("status").notNull().default("registered"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("consultations_client_idx").on(table.clientId),
    index("consultations_lawyer_idx").on(table.lawyerId),
    index("consultations_source_question_idx").on(table.sourceQuestionId),
    check("consultations_message_limit_check", sql`${table.messageLimit} > 0`),
    uniqueIndex("consultations_slot_unique_idx")
      .on(table.slotId)
      .where(sql`${table.slotId} IS NOT NULL`),
  ],
);

export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientId: integer("client_id").references(() => users.id),
  consultationId: integer("consultation_id").references(
    () => consultations.id,
  ),
  type: text("type").notNull(),
  amount: integer("amount").notNull(),
  commissionRate: real("commission_rate").notNull().default(0),
  commissionAmount: integer("commission_amount").notNull().default(0),
  status: text("status").notNull().default("paid"),
  trackingCode: text("tracking_code").notNull(),
  paidAt: text("paid_at"),
  refundedAt: text("refunded_at"),
  createdAt: text("created_at").notNull().default(currentTimestamp),
});

export const reviews = sqliteTable(
  "reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clientId: integer("client_id").references(() => users.id),
    lawyerId: integer("lawyer_id")
      .notNull()
      .references(() => lawyers.id),
    consultationId: integer("consultation_id").references(
      () => consultations.id,
    ),
    consultationType: text("consultation_type").notNull(),
    body: text("body").notNull(),
    rating: integer("rating").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    check("reviews_rating_check", sql`${table.rating} BETWEEN 1 AND 5`),
    unique("reviews_consultation_unique").on(table.consultationId),
    uniqueIndex("reviews_consultation_unique_idx")
      .on(table.consultationId)
      .where(sql`${table.consultationId} IS NOT NULL`),
  ],
);

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clientId: integer("client_id")
      .notNull()
      .references(() => users.id),
    lawyerId: integer("lawyer_id")
      .notNull()
      .references(() => lawyers.id),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    unique("bookmarks_client_lawyer_unique").on(
      table.clientId,
      table.lawyerId,
    ),
  ],
);

export const articles = sqliteTable("articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  excerpt: text("excerpt").notNull(),
  body: text("body").notNull(),
  category: text("category").notNull(),
  author: text("author").notNull(),
  authorUserId: integer("author_user_id").references(() => users.id),
  coverImage: text("cover_image"),
  tags: text("tags").notNull().default("[]"),
  authorAvatar: text("author_avatar"),
  status: text("status").notNull().default("draft"),
  publishedAt: text("published_at"),
  createdAt: text("created_at").notNull().default(currentTimestamp),
}, (table) => [index("articles_author_status_idx").on(table.authorUserId, table.status)]);

export const services = sqliteTable("services", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull().unique(),
  description: text("description").notNull(),
  backDescription: text("back_description").notNull().default(""),
  caseTypes: text("case_types").notNull().default("[]"),
  icon: text("icon").notNull(),
  active: integer("active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const lawyerSpecialties = sqliteTable(
  "lawyer_specialties",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lawyerId: integer("lawyer_id")
      .notNull()
      .references(() => lawyers.id, { onDelete: "cascade" }),
    serviceId: integer("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("lawyer_specialties_lawyer_service_unique").on(
      table.lawyerId,
      table.serviceId,
    ),
    index("lawyer_specialties_service_idx").on(table.serviceId),
  ],
);

export const faqs = sqliteTable("faqs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  active: integer("active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const documents = sqliteTable(
  "documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id),
    lawyerId: integer("lawyer_id").references(() => lawyers.id),
    questionId: integer("question_id").references(() => questions.id),
    consultationId: integer("consultation_id").references(
      () => consultations.id,
    ),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    path: text("path").notNull(),
    mimeType: text("mime_type")
      .notNull()
      .default("application/octet-stream"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("documents_owner_idx").on(table.ownerId, table.createdAt),
    index("documents_question_idx").on(table.questionId),
    index("documents_consultation_idx").on(table.consultationId),
  ],
);

export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  consultationId: integer("consultation_id")
    .notNull()
    .unique()
    .references(() => consultations.id, { onDelete: "cascade" }),
  clientId: integer("client_id")
    .notNull()
    .references(() => users.id),
  lawyerId: integer("lawyer_id")
    .notNull()
    .references(() => lawyers.id),
  status: text("status").notNull().default("open"),
  createdAt: text("created_at").notNull().default(currentTimestamp),
});

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: integer("sender_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("chat_messages_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const adminPermissions = sqliteTable(
  "admin_permissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    adminId: integer("admin_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    allowed: integer("allowed").notNull().default(1),
  },
  (table) => [
    unique("admin_permissions_admin_permission_unique").on(
      table.adminId,
      table.permission,
    ),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(currentTimestamp),
});

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    orderCode: text("order_code"),
    adminReply: text("admin_reply"),
    status: text("status").notNull().default("new"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [index("messages_user_idx").on(table.userId, table.createdAt)],
);

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
});
