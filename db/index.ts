export * from "./schema";

export const localDatabase = {
  dialect: "sqlite",
  path: "data/dadrah.sqlite",
  runtime: "server/db.mjs",
} as const;
