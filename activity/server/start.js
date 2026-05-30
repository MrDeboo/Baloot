import { loadEnvFile } from "./env.js";

loadEnvFile();
await import("./index.js");
