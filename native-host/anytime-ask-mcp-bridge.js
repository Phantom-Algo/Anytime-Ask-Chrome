#!/usr/bin/env node

const { spawn } = require("child_process");

const REQUEST_TIMEOUT_MS = 120000;
const processes = new Map();
let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  readNativeMessages();
});

process.stdin.on("end", () => {
  shutdown();
});

process.on("SIGTERM", () => {
  shutdown();
});

process.on("SIGINT", () => {
  shutdown();
});

function readNativeMessages() {
  while (inputBuffer.length >= 4) {
    const messageLength = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < messageLength + 4) {
      return;
    }

    const rawMessage = inputBuffer.slice(4, 4 + messageLength).toString("utf8");
    inputBuffer = inputBuffer.slice(4 + messageLength);

    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      writeNativeMessage({
        ok: false,
        error: `Invalid native message JSON: ${error.message}`
      });
      continue;
    }

    handleNativeMessage(message).catch((error) => {
      writeNativeMessage({
        bridgeId: message.bridgeId,
        ok: false,
        error: error.message || String(error)
      });
    });
  }
}

async function handleNativeMessage(message) {
  if (message.type !== "mcp.message") {
    throw new Error(`Unsupported native message type: ${message.type}`);
  }

  const server = normalizeServerConfig(message.server);
  const child = ensureMcpProcess(server);
  const rpcMessage = message.message;
  if (!rpcMessage || typeof rpcMessage !== "object") {
    throw new Error("Missing MCP JSON-RPC message.");
  }

  const responsePromise =
    rpcMessage.id === undefined
      ? Promise.resolve(null)
      : waitForMcpResponse(child, rpcMessage.id, rpcMessage.method);

  try {
    writeMcpMessage(child, rpcMessage);
  } catch (error) {
    clearPending(child, rpcMessage.id);
    throw error;
  }
  const rpcResponse = await responsePromise;
  writeNativeMessage({
    bridgeId: message.bridgeId,
    ok: true,
    message: rpcResponse
  });
}

function normalizeServerConfig(server) {
  if (!server || typeof server !== "object") {
    throw new Error("Missing stdio MCP server config.");
  }

  const id = String(server.id || "").trim();
  const command = String(server.command || "").trim();
  if (!id) {
    throw new Error("stdio MCP server missing id.");
  }
  if (!command) {
    throw new Error(`stdio MCP server ${id} missing command.`);
  }

  return {
    id,
    name: String(server.name || id),
    command,
    args: Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : [],
    cwd: String(server.cwd || "").trim(),
    env: normalizeEnv(server.env)
  };
}

function ensureMcpProcess(server) {
  const processKey = getProcessKey(server);
  const existing = processes.get(processKey);
  if (existing && !existing.exited) {
    return existing;
  }

  const childProcess = spawn(server.command, server.args, {
    cwd: server.cwd || undefined,
    env: {
      ...process.env,
      ...server.env
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  const child = {
    key: processKey,
    server,
    process: childProcess,
    stdoutBuffer: "",
    pending: new Map(),
    exited: false
  };
  processes.set(processKey, child);

  childProcess.stdout.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk) => {
    child.stdoutBuffer += chunk;
    readMcpMessages(child);
  });

  childProcess.stderr.setEncoding("utf8");
  childProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[${server.id}] ${chunk}`);
  });

  childProcess.on("error", (error) => {
    rejectAllPending(child, error);
  });

  childProcess.on("exit", (code, signal) => {
    child.exited = true;
    processes.delete(processKey);
    rejectAllPending(
      child,
      new Error(`MCP server ${server.id} exited with code ${code ?? "null"} signal ${signal ?? "null"}.`)
    );
  });

  return child;
}

function readMcpMessages(child) {
  let newlineIndex = child.stdoutBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = child.stdoutBuffer.slice(0, newlineIndex).trim();
    child.stdoutBuffer = child.stdoutBuffer.slice(newlineIndex + 1);
    if (line) {
      handleMcpMessage(child, line);
    }
    newlineIndex = child.stdoutBuffer.indexOf("\n");
  }
}

function handleMcpMessage(child, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`[${child.server.id}] Invalid MCP stdout JSON: ${error.message}\n`);
    return;
  }

  if (message.id !== undefined && child.pending.has(String(message.id))) {
    const pending = child.pending.get(String(message.id));
    child.pending.delete(String(message.id));
    clearTimeout(pending.timeoutId);
    pending.resolve(message);
    return;
  }

  if (message.id !== undefined && message.method) {
    writeMcpMessage(child, {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Client method not supported by Anytime Ask bridge: ${message.method}`
      }
    });
  }
}

function waitForMcpResponse(child, id, method) {
  const key = String(id);
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      child.pending.delete(key);
      reject(new Error(`MCP server ${child.server.id} timed out waiting for ${method || id}.`));
    }, REQUEST_TIMEOUT_MS);

    child.pending.set(key, {
      resolve,
      reject,
      timeoutId
    });
  });
}

function clearPending(child, id) {
  if (id === undefined) {
    return;
  }

  const key = String(id);
  const pending = child.pending.get(key);
  if (!pending) {
    return;
  }

  child.pending.delete(key);
  clearTimeout(pending.timeoutId);
}

function writeMcpMessage(child, message) {
  if (child.exited || !child.process.stdin.writable) {
    throw new Error(`MCP server ${child.server.id} stdin is not writable.`);
  }
  child.process.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
}

function writeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function rejectAllPending(child, error) {
  for (const pending of child.pending.values()) {
    clearTimeout(pending.timeoutId);
    pending.reject(error);
  }
  child.pending.clear();
}

function normalizeEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return {};
  }

  return Object.entries(env).reduce((record, [key, value]) => {
    const envKey = String(key || "").trim();
    if (envKey) {
      record[envKey] = String(value);
    }
    return record;
  }, {});
}

function getProcessKey(server) {
  return JSON.stringify({
    id: server.id,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: server.env
  });
}

function shutdown() {
  for (const child of processes.values()) {
    rejectAllPending(child, new Error("Anytime Ask MCP bridge is shutting down."));
    child.process.kill();
  }
  processes.clear();
  process.exit(0);
}
