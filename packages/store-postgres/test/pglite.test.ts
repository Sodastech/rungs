import { serviceSuite, storeContract } from "@rungsjs/store-contract";
import { afterAll } from "vitest";
import { pgliteHarness } from "./helpers.js";

// The shared suites every adapter must pass, against real PostgreSQL compiled to WASM (PGlite),
// so they run anywhere without a database server. CI also runs them on PostgreSQL 15 to 18.
const harness = pgliteHarness();
afterAll(() => harness.close());

storeContract("postgresStore on PGlite", () => harness.freshStore());
serviceSuite("postgresStore on PGlite", () => harness.freshStore());
