import { serviceSuite, storeContract } from "@rungs/store-contract";
import { memoryStore } from "../src/index.js";

storeContract("memoryStore", () => memoryStore());
serviceSuite("memoryStore", () => memoryStore());
