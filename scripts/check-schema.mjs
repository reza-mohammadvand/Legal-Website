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
  const articleColumns = database
    .prepare("PRAGMA table_info(articles)")
    .all()
    .map((column) => column.name);
  for (const column of ["cover_image", "tags", "author_avatar"]) {
    assert.ok(articleColumns.includes(column), `articles.${column} is missing`);
  }
  console.log("Dadrah schema migration is valid and contains all 20 tables.");
} finally {
  database.close();
}
