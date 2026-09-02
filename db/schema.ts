import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["client", "lawyer", "admin"] }).notNull(),
  firstName: text("first_name").notNull(), lastName: text("last_name").notNull(),
  email: text("email").notNull().unique(), phone: text("phone").notNull(),
  province: text("province"), city: text("city"), status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export const lawyers = sqliteTable("lawyers", {
  id: integer("id").primaryKey({ autoIncrement: true }), userId: integer("user_id").notNull().references(() => users.id),
  licenseNumber: text("license_number").notNull(), specialties: text("specialties").notNull(), bio: text("bio").notNull(),
  phonePrice: integer("phone_price").notNull(), textPrice: integer("text_price").notNull(), inPersonPrice: integer("in_person_price"),
  rating: real("rating").notNull().default(0), verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  featured: integer("featured", { mode: "boolean" }).notNull().default(false), online: integer("online", { mode: "boolean" }).notNull().default(false),
  inPersonEnabled: integer("in_person_enabled", { mode: "boolean" }).notNull().default(false),
});
export const questions = sqliteTable("questions", {id:integer("id").primaryKey({autoIncrement:true}),clientId:integer("client_id").references(()=>users.id),lawyerId:integer("lawyer_id").references(()=>lawyers.id),topic:text("topic").notNull(),body:text("body").notNull(),kind:text("kind").notNull(),status:text("status").notNull().default("new"),publishAllowed:integer("publish_allowed",{mode:"boolean"}).notNull().default(false),createdAt:integer("created_at",{mode:"timestamp"}).notNull()});
export const answers = sqliteTable("answers", {id:integer("id").primaryKey({autoIncrement:true}),questionId:integer("question_id").notNull().references(()=>questions.id),lawyerId:integer("lawyer_id").notNull().references(()=>lawyers.id),body:text("body").notNull(),published:integer("published",{mode:"boolean"}).notNull().default(false),createdAt:integer("created_at",{mode:"timestamp"}).notNull()});
export const consultations = sqliteTable("consultations", {id:integer("id").primaryKey({autoIncrement:true}),clientId:integer("client_id").notNull().references(()=>users.id),lawyerId:integer("lawyer_id").notNull().references(()=>lawyers.id),type:text("type").notNull(),topic:text("topic").notNull(),scheduledAt:integer("scheduled_at",{mode:"timestamp"}),amount:integer("amount").notNull(),paymentStatus:text("payment_status").notNull(),status:text("status").notNull(),createdAt:integer("created_at",{mode:"timestamp"}).notNull()});
export const orders = sqliteTable("orders", {id:integer("id").primaryKey({autoIncrement:true}),clientId:integer("client_id").notNull().references(()=>users.id),consultationId:integer("consultation_id").references(()=>consultations.id),amount:integer("amount").notNull(),status:text("status").notNull(),trackingCode:text("tracking_code"),createdAt:integer("created_at",{mode:"timestamp"}).notNull(),paidAt:integer("paid_at",{mode:"timestamp"})});
export const reviews = sqliteTable("reviews", {id:integer("id").primaryKey({autoIncrement:true}),clientId:integer("client_id").notNull().references(()=>users.id),lawyerId:integer("lawyer_id").notNull().references(()=>lawyers.id),type:text("type").notNull(),body:text("body").notNull(),rating:integer("rating").notNull(),visible:integer("visible",{mode:"boolean"}).notNull().default(false),createdAt:integer("created_at",{mode:"timestamp"}).notNull()});
export const appointments = sqliteTable("appointment_slots", {id:integer("id").primaryKey({autoIncrement:true}),lawyerId:integer("lawyer_id").notNull().references(()=>lawyers.id),startsAt:integer("starts_at",{mode:"timestamp"}).notNull(),endsAt:integer("ends_at",{mode:"timestamp"}).notNull(),status:text("status").notNull().default("available")});
export const files = sqliteTable("files", {id:integer("id").primaryKey({autoIncrement:true}),ownerId:integer("owner_id").notNull().references(()=>users.id),questionId:integer("question_id").references(()=>questions.id),objectKey:text("object_key").notNull(),fileName:text("file_name").notNull(),mimeType:text("mime_type").notNull(),size:integer("size").notNull(),createdAt:integer("created_at",{mode:"timestamp"}).notNull()});
export const bookmarks = sqliteTable("bookmarks", {id:integer("id").primaryKey({autoIncrement:true}),clientId:integer("client_id").notNull().references(()=>users.id),lawyerId:integer("lawyer_id").notNull().references(()=>lawyers.id),createdAt:integer("created_at",{mode:"timestamp"}).notNull()});
export const messages = sqliteTable("messages", {id:integer("id").primaryKey({autoIncrement:true}),userId:integer("user_id").references(()=>users.id),kind:text("kind").notNull(),subject:text("subject").notNull(),body:text("body").notNull(),status:text("status").notNull().default("new"),createdAt:integer("created_at",{mode:"timestamp"}).notNull()});
export const articles = sqliteTable("articles", {id:integer("id").primaryKey({autoIncrement:true}),slug:text("slug").notNull().unique(),title:text("title").notNull(),excerpt:text("excerpt").notNull(),body:text("body").notNull(),category:text("category").notNull(),tags:text("tags"),authorId:integer("author_id").references(()=>users.id),status:text("status").notNull().default("draft"),publishedAt:integer("published_at",{mode:"timestamp"})});
export const adminPermissions = sqliteTable("admin_permissions", {id:integer("id").primaryKey({autoIncrement:true}),adminId:integer("admin_id").notNull().references(()=>users.id),permission:text("permission").notNull(),allowed:integer("allowed",{mode:"boolean"}).notNull().default(false)});
