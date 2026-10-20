import { expect, it } from "vitest";
import * as store from "../src/index.js";

// Everything exported from the entry point is public API (CLAUDE.md rule 4).
// Changing this list requires updating docs/04-api-design.md and adding a changeset.
it("exports exactly the documented runtime API", () => {
  expect(Object.keys(store).sort()).toEqual([
    "SCHEMA_VERSION",
    "fromPg",
    "fromPglite",
    "fromPostgresJs",
    "migrate",
    "migrationSql",
    "postgresStore",
    "purgeDispatchedEvents",
    "purgeIdempotency",
    "purgeRequest",
    "purgeRequests",
  ]);
});
