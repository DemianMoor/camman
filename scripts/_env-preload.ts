// Side-effect import: loads .env.local BEFORE any app module (e.g. db/client,
// which reads process.env.DATABASE_URL at import time). Import this FIRST in a
// script that pulls in app code — ESM evaluates imports in source order, so the
// env is populated before db/client initializes its connection.
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });
