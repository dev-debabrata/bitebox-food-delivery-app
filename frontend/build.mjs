import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.NG_BUILD_SASS_EMBEDDED = "0";

console.log("Building Angular frontend...");
execSync("npx ng build", {
  cwd: __dirname,
  stdio: "inherit",
  env: { ...process.env, NG_BUILD_SASS_EMBEDDED: "0" },
});

const csrPath = path.join(__dirname, "dist/frontend/browser/index.csr.html");
const indexPath = path.join(__dirname, "dist/frontend/browser/index.html");

if (fs.existsSync(csrPath)) {
  fs.copyFileSync(csrPath, indexPath);
  console.log("Successfully created index.html from index.csr.html for SPA static routing.");
} else {
  console.warn("Warning: index.csr.html not found at", csrPath);
}
