#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.anytime_ask.mcp_bridge";
const args = parseArgs(process.argv.slice(2));

if (!args.extensionId) {
  console.error("Usage: node scripts/install-native-host.mjs --extension-id <chrome-extension-id>");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgePath = path.join(repoRoot, "native-host", "anytime-ask-mcp-bridge.js");
const manifestDir = getManifestDir(args.browser || "chrome");
const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);

fs.mkdirSync(manifestDir, { recursive: true });
fs.chmodSync(bridgePath, 0o755);
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      name: HOST_NAME,
      description: "Anytime Ask MCP stdio Native Messaging bridge",
      path: bridgePath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${args.extensionId}/`]
    },
    null,
    2
  )}\n`
);

console.log(`Installed native host manifest: ${manifestPath}`);
console.log(`Bridge executable: ${bridgePath}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--extension-id") {
      parsed.extensionId = argv[index + 1];
      index += 1;
    } else if (arg === "--browser") {
      parsed.browser = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function getManifestDir(browser) {
  const home = os.homedir();
  const platform = os.platform();
  const normalized = String(browser || "chrome").toLowerCase();

  if (platform === "darwin") {
    const appName = normalized === "edge"
      ? "Microsoft Edge"
      : normalized === "chromium"
        ? "Chromium"
        : "Google/Chrome";
    return path.join(
      home,
      "Library",
      "Application Support",
      appName,
      "NativeMessagingHosts"
    );
  }

  if (platform === "win32") {
    throw new Error("Windows native host install needs registry setup; please create the manifest manually.");
  }

  const configRoot = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const appName = normalized === "edge"
    ? "microsoft-edge"
    : normalized === "chromium"
      ? "chromium"
      : "google-chrome";
  return path.join(configRoot, appName, "NativeMessagingHosts");
}
