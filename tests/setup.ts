import { afterAll } from "vitest";
import { disconnectDatabase } from "../src/config/database";

afterAll(async () => {
  await disconnectDatabase();
});
