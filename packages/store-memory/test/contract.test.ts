import { serviceSuite, storeContract } from "@rungsjs/store-contract";
import { memoryStore } from "../src/index.js";

storeContract("memoryStore", () => memoryStore());
serviceSuite("memoryStore", () => memoryStore());
