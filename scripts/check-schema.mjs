import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const expectedTables = [
  "admin_permissions",
  "answers",
  "appointment_slots",
  "articles",
  "bookmarks",
  "chat_messages",
  "consultations",
  "conversations",
  "documents",
  "faqs",
  "lawyer_specialties",
  "lawyers",
  "messages",
  "orders",
  "question_assignments",
  "questions",
  "reviews",
  "services",
  "sessions",
  "settings",
  "users",
];

const database = new DatabaseSync(":memory:");
try {
  database.exec("PRAGMA foreign_keys=ON;");
  database.exec(readFileSync("drizzle/0000_dadrah_core.sql", "utf8"));
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, expectedTables);
  const requiredColumns = {
    users: ["avatar_url"],
    lawyers: ["profile_completed"],
    articles: ["cover_image", "tags", "author_avatar", "author_user_id"],
    consultations: ["source_question_id", "message_limit", "urgent", "base_amount", "urgent_surcharge_rate", "urgent_surcharge_amount"],
    services: ["back_description", "case_types"],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    for (const column of columns) assert.ok(actual.includes(column), `${table}.${column} is missing`);
  }
  assert.throws(() => database.prepare("INSERT INTO consultations(type,topic,message_limit) VALUES('text','Test',0)").run(), /CHECK constraint/);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  console.log("Dadrah schema migration is valid and contains all 21 tables.");
} finally {
  database.close();
}
