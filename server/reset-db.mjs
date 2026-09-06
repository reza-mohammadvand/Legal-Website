import { mkdirSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { db, dbPath } from "./db.mjs";

const dataDirectory = resolve("data");
const uploadsDirectory = resolve(dataDirectory, "uploads");
const relativeUploads = relative(dataDirectory, uploadsDirectory);
if (!relativeUploads || relativeUploads === ".." || relativeUploads.startsWith(".." + sep) || isAbsolute(relativeUploads)) {
  throw new Error("Refusing to reset uploads outside the local Dadrah data directory.");
}

db.close();
for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try { rmSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
rmSync(uploadsDirectory, { recursive: true, force: true });
mkdirSync(uploadsDirectory, { recursive: true });
console.log("Dadrah local database and uploads were reset. They will be seeded on next start.");
