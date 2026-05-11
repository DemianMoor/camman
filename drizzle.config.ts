import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ["public"],
});
