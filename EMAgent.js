#!/usr/bin/env node

"use strict";

const readline = require("readline");
const { exit } = require("process");
const util = require("util");

const {
  readFile: _readFile,
  writeFile: _writeFile,
  access,
} = require("fs").promises;

const { exec } = require("child_process");
const execAsync = util.promisify(exec);



const DEFAULTS = {
  LM_HOST: "localhost",
  LM_PORT: 1234,
  MODEL: "gpt-oss-20b",
  TEMP: 0.7,
  MAX_TOKENS: -1,
  MAX_HISTORY: -1,
  CONTEXT_WINDOW: 128000,
  TOOL_TIMEOUT: 30000,
  MAX_BUFFER: 10 * 1024 * 1024,
  RETRY_COUNT: 3,
  RETRY_BACKOFF_MS: 500,
  CHARS_PER_TOKEN: 4,
  SAVE_FILE: null,
  WAKEUP_MESSAGE: "[SYSTEM: Timer wakeup triggered]",
};



function getConfig() {
  const cfg = { ...DEFAULTS };

  // Environment variables (prefix: EMAGENT_)
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("EMAGENT_")) {
      const key = k.slice(8); 
      if (key in cfg) {
        cfg[key] = isNaN(v) ? v : Number(v);
      }
    }
  }

  // CLI flags
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--host":
        cfg.LM_HOST = argv[++i];
        break;
      case "--port":
        cfg.LM_PORT = Number(argv[++i]);
        break;
      case "--model":
        cfg.MODEL = argv[++i];
        break;
      case "--temp":
        cfg.TEMP = Number(argv[++i]);
        break;
      case "--max-tokens":
        cfg.MAX_TOKENS = Number(argv[++i]);
        break;
      case "--max-history":
        cfg.MAX_HISTORY = Number(argv[++i]);
        break;
      case "--context-window":
        cfg.CONTEXT_WINDOW = Number(argv[++i]);
        break;
      case "--tool-timeout":
        cfg.TOOL_TIMEOUT = Number(argv[++i]);
        break;
      case "--save":
        cfg.SAVE_FILE = argv[++i];
        break;
      case "-h":
      case "--help":
        console.log(
          `Usage: node EMAgent.js [options]\n\n` +
            `Options:\n` +
            `  --host <addr>          LM host (default ${DEFAULTS.LM_HOST})\n` +
            `  --port <num>           LM port (default ${DEFAULTS.LM_PORT})\n` +
            `  --model <name>         Model name (default ${DEFAULTS.MODEL})\n` +
            `  --temp <float>         Temperature (default ${DEFAULTS.TEMP})\n` +
            `  --max-tokens <num>     Max tokens to request (-1 = unlimited)\n` +
            `  --max-history <num>    Max conversation entries (-1 = unlimited)\n` +
            `  --context-window <num> Context window in tokens (default ${DEFAULTS.CONTEXT_WINDOW})\n` +
            `  --tool-timeout <ms>    Tool execution timeout (default ${DEFAULTS.TOOL_TIMEOUT})\n` +
            `  --save <file>          Save/load conversation from file\n` +
            `  -h, --help             Show this help\n\n` +
            `Commands (during chat):\n` +
            `  exit, quit             Exit the agent\n` +
            `  save                   Manually save conversation\n` +
            `  clear                  Clear conversation history\n` +
            `  tokens                 Show token usage estimate`
        );
        exit(0);
    }
  }

  return cfg;
}

const CONFIG = getConfig();



let conversation = [];
let isProcessing = false;
let pendingWakeups = [];

const SYSTEM_PROMPT = {
  role: "system",
  content: `You are an AI assistant whose primary goal is to help users complete any task that can be achieved with the tools available to you. Follow these principles:

1. **Tool-First Action**  
   - If a user's request matches one of your built-in capabilities, use the appropriate tool immediately and return the result in a clear, concise format.

2. **Graceful Fallback**  
   - When a task is outside the scope of your current tools or you lack necessary information, politely ask the user for clarification or an alternative approach before proceeding.

3. **Tone & Clarity**  
   - Respond in a friendly, professional manner. Keep explanations brief but complete, and structure outputs (e.g., tables, bullet points) when helpful.

4. **Self-Check**  
   - After executing a tool, confirm the output meets user expectations; if not, prompt for additional detail or corrections.

5. **Transparency**  
   - If you're unsure whether a task is doable with your tools, explicitly state that limitation and request guidance from the user.

By adhering to these guidelines, you'll efficiently assist users while ensuring transparency when limitations arise.`,
};



function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / DEFAULTS.CHARS_PER_TOKEN);
}

function getConversationTokens() {
  let total = estimateTokens(SYSTEM_PROMPT.content);
  for (const msg of conversation) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (msg.content) {
      total += estimateTokens(JSON.stringify(msg.content));
    }
    if (msg.tool_calls) {
      total += estimateTokens(JSON.stringify(msg.tool_calls));
    }
  }
  return total;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printSection(title) {
  const padding = Math.max(0, 54 - title.length);
  console.log(`\n┌─── ${title} ${"─".repeat(padding)}┐`);
}

function printSectionLine(content) {
  console.log(`│ ${content}`);
}

function printSectionEnd() {
  console.log(`\n└${"─".repeat(60)}┘`);
}

function truncateString(str, maxLen = 200) {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}



async function saveConversation() {
  if (!CONFIG.SAVE_FILE) return;
  try {
    await _writeFile(
      CONFIG.SAVE_FILE,
      JSON.stringify(conversation, null, 2),
      { encoding: "utf8" }
    );
  } catch (e) {
    console.error(`⚠️  Failed to save conversation: ${e.message}`);
  }
}

async function loadConversation() {
  if (!CONFIG.SAVE_FILE) return;
  try {
    await access(CONFIG.SAVE_FILE);
    const data = await _readFile(CONFIG.SAVE_FILE, { encoding: "utf8" });
    conversation = JSON.parse(data);
    console.log(`📂 Loaded ${conversation.length} messages from ${CONFIG.SAVE_FILE}`);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`⚠️  Failed to load conversation: ${e.message}`);
    }
  }
}


async function checkAndManageContext() {
  const tokens = getConversationTokens();
  const threshold = CONFIG.CONTEXT_WINDOW * 0.9;

  if (tokens > threshold) {
    console.log(
      `\n⚠️  Context window nearly full (${tokens}/${CONFIG.CONTEXT_WINDOW} tokens)`
    );
    const answer = await promptUser(
      "Do you want the model to summarize and continue? [y/N] "
    );

    if (answer.toLowerCase() === "y") {
      await summarizeConversation();
      return true;
    }
    return false;
  }

  if (CONFIG.MAX_HISTORY > 0 && conversation.length > CONFIG.MAX_HISTORY) {
    console.log(
      `\n⚠️  Max history exceeded (${conversation.length}/${CONFIG.MAX_HISTORY} entries)`
    );
    const answer = await promptUser(
      "Do you want the model to summarize and continue? [y/N] "
    );

    if (answer.toLowerCase() === "y") {
      await summarizeConversation();
      return true;
    }
    return false;
  }

  return true;
}

async function summarizeConversation() {
  printSection("Summarizing Conversation");

  const summaryPrompt = {
    role: "user",
    content:
      "Please provide a concise summary of our conversation so far, capturing all key points, decisions, and context needed to continue. This will replace the detailed history.",
  };

  const tempConv = [...conversation, summaryPrompt];

  const payload = {
    model: CONFIG.MODEL,
    messages: [SYSTEM_PROMPT, ...tempConv],
    temperature: 0.3,
    max_tokens: 2000,
    stream: false,
  };

  try {
    const res = await fetch(
      `http://${CONFIG.LM_HOST}:${CONFIG.LM_PORT}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content || "";

    conversation = [
      {
        role: "assistant",
        content: `[CONVERSATION SUMMARY]\n${summary}\n[END SUMMARY - Conversation continues below]`,
      },
    ];

    printSectionLine("✓ Conversation summarized successfully");
    printSectionEnd();
    await saveConversation();
  } catch (e) {
    printSectionLine(`✗ Failed to summarize: ${e.message}`);
    printSectionEnd();
  }
}



async function set_time_out({ time }) {
  if (typeof time !== "number" || !Number.isFinite(time)) {
    return { error: "`time` must be a finite number of milliseconds" };
  }

  setTimeout(() => {
    if (isProcessing) {
      pendingWakeups.push({ time: Date.now() });
    } else {
      conversation.push({
        role: "user",
        content: DEFAULTS.WAKEUP_MESSAGE,
      });
      processPendingAndSend();
    }
  }, time);

  return { status: `Timer set for ${time} ms` };
}

async function read_file({ path: filePath, start_line = 0, end_line }) {
  try {
    const data = await _readFile(filePath, { encoding: "utf8" });
    const lines = data.split(/\r?\n/);
    const s = Math.max(0, typeof start_line === "number" ? start_line : 0);
    const e =
      typeof end_line === "undefined"
        ? lines.length
        : Math.min(
            lines.length,
            typeof end_line === "number" ? end_line : lines.length
          );
    const selected = lines.slice(s, e).join("\n");
    return {
      content: selected,
      total_lines: lines.length,
      returned_lines: e - s,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function write_file({
  path: filePath,
  content = "",
  encoding = "utf8",
  append = false,
}) {
  try {
    const flag = append ? "a" : "w";
    await _writeFile(filePath, content, { flag, encoding });
    return {
      status: "success",
      bytes_written: Buffer.byteLength(content, encoding),
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function edit_file({ path: filePath, find = "", replace = "" }) {
  try {
    if (!find) {
      return { error: "'find' must be a non-empty string" };
    }

    const oldContent = await _readFile(filePath, { encoding: "utf8" });

    const regex = new RegExp(escapeRegex(find), "g");
    const matches = oldContent.match(regex);
    const count = matches ? matches.length : 0;

    if (count === 0) {
      return {
        status: "no_match",
        replacements: 0,
        message: "String not found in file",
      };
    }

    const newContent = oldContent.split(find).join(replace);
    await _writeFile(filePath, newContent, { encoding: "utf8" });

    return { status: "edited", replacements: count };
  } catch (e) {
    return { error: e.message };
  }
}

async function exec_shell({ command }) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: DEFAULTS.MAX_BUFFER,
      timeout: CONFIG.TOOL_TIMEOUT,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    if (e.killed) {
      return {
        error: `Command timed out after ${CONFIG.TOOL_TIMEOUT}ms`,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        code: -1,
      };
    }
    return {
      error: e.message,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : -1,
    };
  }
}



const TOOL_DEFINITIONS = {
  set_time_out,
  read_file,
  write_file,
  edit_file,
  exec_shell,
};

const TOOLS_LIST = [
  {
    type: "function",
    function: {
      name: "set_time_out",
      description:
        "Schedule a wake-up for the assistant after <time> ms. When the timer expires, the model will receive a notification.",
      parameters: {
        type: "object",
        properties: {
          time: { type: "number", description: "delay in ms" },
        },
        required: ["time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file and return its contents. Optional start_line (0-based) and end_line (exclusive).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File system path" },
          start_line: {
            type: "integer",
            description: "Start line index (0-based)",
          },
          end_line: {
            type: "integer",
            description: "End line index (exclusive)",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write text to a file. By default it overwrites; use `append:true` to append.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File system path" },
          content: { type: "string", description: "Text to write" },
          encoding: {
            type: "string",
            enum: ["utf8", "ascii", "base64"],
            default: "utf8",
          },
          append: {
            type: "boolean",
            description: "Append instead of overwrite",
            default: false,
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Find-and-replace in a file. Replaces all occurrences and returns the count.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File system path" },
          find: { type: "string", description: "String to find (exact match)" },
          replace: { type: "string", description: "Replacement string" },
        },
        required: ["path", "find", "replace"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "exec_shell",
      description: `Execute a shell command. Returns stdout, stderr, exit code. Timeout: ${DEFAULTS.TOOL_TIMEOUT}ms.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];



function parseStreamChunk(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();

  if (data === "[DONE]") return { done: true };

  try {
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}

async function* streamChunks(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder(); 
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const chunk = parseStreamChunk(raw);
      if (!chunk) continue;
      yield chunk;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const chunk = parseStreamChunk(buffer);
    if (chunk) yield chunk;
  }
}



async function runToolCalls(calls) {
  const results = [];

  for (const call of calls) {
    const { name, arguments: argsStr } = call.function;
    let parsedArgs;

    printSection(`Tool: ${name}`);
    printSectionLine(`ID: ${call.id}`);
    printSectionLine(`Args: ${truncateString(argsStr, 100)}`);

    try {
      parsedArgs = JSON.parse(argsStr || "{}");
    } catch (e) {
      printSectionLine(`❌ Invalid JSON`);
      printSectionEnd();
      results.push({
        id: call.id,
        error: `Invalid JSON for ${name}: ${argsStr}`,
      });
      continue;
    }

    if (!(name in TOOL_DEFINITIONS)) {
      printSectionLine(`❌ Unknown tool`);
      printSectionEnd();
      results.push({ id: call.id, error: `Unknown tool "${name}"` });
      continue;
    }

    try {
      const result = await TOOL_DEFINITIONS[name](parsedArgs);
      const resultStr = JSON.stringify(result, null, 2);
      printSectionLine(`✓ Result: ${truncateString(resultStr, 150)}`);
      printSectionEnd();
      results.push({ id: call.id, result });
    } catch (e) {
      printSectionLine(`❌ Error: ${e.message}`);
      printSectionEnd();
      results.push({
        id: call.id,
        error: e.message ?? String(e),
      });
    }
  }

  return results;
}



async function sendChat(conv) {
  const payload = {
    model: CONFIG.MODEL,
    messages: [SYSTEM_PROMPT, ...conv],
    temperature: CONFIG.TEMP,
    max_tokens: CONFIG.MAX_TOKENS,
    stream: true,
    tools: TOOLS_LIST,
  };

  let res;
  for (let attempt = 1; attempt <= DEFAULTS.RETRY_COUNT; attempt++) {
    try {
      res = await fetch(
        `http://${CONFIG.LM_HOST}:${CONFIG.LM_PORT}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      break;
    } catch (err) {
      console.warn(
        `⚠️  Attempt ${attempt}/${DEFAULTS.RETRY_COUNT} failed: ${err.message}`
      );
      if (attempt === DEFAULTS.RETRY_COUNT) throw err;
      await new Promise((r) =>
        setTimeout(r, attempt * DEFAULTS.RETRY_BACKOFF_MS)
      );
    }
  }

  const result = {
    content: "",
    toolCalls: [],
    toolResults: [],
  };

  let partialToolCalls = [];
  let reasoningText = "";
  let inContent = false;
  let inReasoning = false;
  let inToolCalls = false;

  for await (const chunk of streamChunks(res)) {
    if (chunk.done) break;

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if ("content" in delta && typeof delta.content === "string") {
      if (!inContent) {
        if (inReasoning || inToolCalls) {
          printSectionEnd();
        }
        if (reasoningText) {
          conversation.push({
            role: "assistant",
            content: `<thinking>${reasoningText}</thinking>`,
          });
          reasoningText = "";
        }
        inContent = true;
        inReasoning = false;
        inToolCalls = false;
        printSection("Response");
      }
      result.content += delta.content;
      process.stdout.write(delta.content);
    } else if ("reasoning" in delta && typeof delta.reasoning === "string") {
      if (!inReasoning) {
        if (inContent || inToolCalls) {
          printSectionEnd();
        }
        inReasoning = true;
        inContent = false;
        inToolCalls = false;
        printSection("Reasoning");
      }
      reasoningText += delta.reasoning;
      process.stdout.write(delta.reasoning);
    } else if (Array.isArray(delta.tool_calls)) {
      if (!inToolCalls) {
        if (inReasoning || inContent) {
          printSectionEnd();
        }
        if (reasoningText) {
          conversation.push({
            role: "assistant",
            content: `<thinking>${reasoningText}</thinking>`,
          });
          reasoningText = "";
        }
        inToolCalls = true;
        inReasoning = false;
        inContent = false;
        printSection("Tool Calls");
      }

      for (const part of delta.tool_calls) {
        let pc = partialToolCalls.find((t) => t.index === part.index);
        if (!pc) {
          pc = {
            index: part.index,
            id: part.id,
            type: part.type || "function",
          };
          pc.function = { name: part.function?.name ?? "", arguments: "" };
          partialToolCalls.push(pc);
        }
        if (part.function?.name && !pc.function.name) {
          pc.function.name = part.function.name;
          printSectionLine(`[${partialToolCalls.length}] ${pc.function.name}`);
        }
        if (part.function?.arguments) {
          pc.function.arguments += part.function.arguments;
        }
      }
    }
  }

  if (inContent || inReasoning || inToolCalls) {
    printSectionEnd();
  }

  if (reasoningText) {
    conversation.push({
      role: "assistant",
      content: `<thinking>${reasoningText}</thinking>`,
    });
  }

  // FIXED: Proper OpenAI-compatible tool_calls format
  if (partialToolCalls.length > 0) {
    result.toolCalls = partialToolCalls.map((tc) => ({
      id: tc.id,
      type: tc.type || "function",
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    const toolResults = await runToolCalls(result.toolCalls);
    result.toolResults = toolResults;
  }

  return result;
}



async function processPendingAndSend() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    await sendMessage();
  } finally {
    isProcessing = false;

    // Process any pending wakeups that occurred during processing
    while (pendingWakeups.length > 0) {
      const wakeup = pendingWakeups.shift();
      conversation.push({
        role: "user",
        content: `[SYSTEM: Deferred timer wakeup (queued at ${new Date(wakeup.time).toISOString()})]`,
      });
      isProcessing = true;
      try {
        await sendMessage();
      } finally {
        isProcessing = false;
      }
    }
  }
}

async function sendMessage() {
  
  while (true) {
    try {
      const result = await sendChat(conversation);

      
      const assistantEntry = {
        role: "assistant",
        content: result.content || null,
      };

      if (result.toolCalls.length > 0) {
        assistantEntry.tool_calls = result.toolCalls;
      }

      conversation.push(assistantEntry);

      
      if (result.toolResults.length > 0) {
        for (const tr of result.toolResults) {
          conversation.push({
            role: "tool",
            tool_call_id: tr.id,
            content: JSON.stringify(tr.result ?? { error: tr.error }),
          });
        }
        await saveConversation();
        continue; // Loop to let model see tool results
      }

      await saveConversation();
      break; // No tool calls - done
    } catch (err) {
      console.error(`\n⚠️  Error: ${err.message ?? String(err)}`);
      break;
    }
  }
}



const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function promptUser(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}



function setupSignalHandlers() {
  const cleanup = async (signal) => {
    console.log(`\n\n📤 Received ${signal}, saving conversation...`);
    await saveConversation();
    console.log("👋 Goodbye!");
    rl.close();
    process.exit(0);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  // SIGHUP may not exist on Windows
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => cleanup("SIGHUP"));
  }

  process.on("uncaughtException", async (err) => {
    console.error("\n💥 Uncaught exception:", err.message);
    await saveConversation();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("\n💥 Unhandled rejection:", reason);
    await saveConversation();
    process.exit(1);
  });
}



async function main() {
  setupSignalHandlers();

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║              🤖 EMAgent - CLI AI Assistant                 ║");
  console.log("╠════════════════════════════════════════════════════════════╣");
  console.log(`║ Model: ${CONFIG.MODEL.padEnd(52)}║`);
  console.log(
    `║ Server: ${(CONFIG.LM_HOST + ":" + CONFIG.LM_PORT).padEnd(51)}║`
  );
  console.log(`║ Context: ${String(CONFIG.CONTEXT_WINDOW).padEnd(50)}║`);
  console.log(
    `║ Tool Timeout: ${String(CONFIG.TOOL_TIMEOUT + "ms").padEnd(45)}║`
  );
  if (CONFIG.SAVE_FILE) {
    console.log(`║ Save File: ${CONFIG.SAVE_FILE.padEnd(48)}║`);
  }
  console.log("╠════════════════════════════════════════════════════════════╣");
  console.log("║ Commands: exit, save, clear, tokens                        ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  await loadConversation();

  while (true) {
    const userInput = await promptUser("You: ");
    if (!userInput.trim()) continue;

    const cmd = userInput.toLowerCase().trim();

    if (cmd === "exit" || cmd === "quit") {
      await saveConversation();
      console.log("👋 Goodbye!");
      break;
    }

    if (cmd === "save") {
      if (CONFIG.SAVE_FILE) {
        await saveConversation();
        console.log(`💾 Saved to ${CONFIG.SAVE_FILE}`);
      } else {
        console.log("⚠️  No save file specified. Use --save <file>");
      }
      continue;
    }

    if (cmd === "clear") {
      conversation = [];
      console.log("🗑️  Conversation cleared.");
      await saveConversation();
      continue;
    }

    if (cmd === "tokens") {
      const tokens = getConversationTokens();
      const pct = ((tokens / CONFIG.CONTEXT_WINDOW) * 100).toFixed(1);
      console.log(
        `📊 Tokens: ${tokens}/${CONFIG.CONTEXT_WINDOW} (${pct}%) | Messages: ${conversation.length}`
      );
      continue;
    }

    const canContinue = await checkAndManageContext();
    if (!canContinue) {
      console.log(
        "⚠️  Continuing without summarization. Context may be truncated."
      );
    }

    conversation.push({ role: "user", content: userInput });

    await processPendingAndSend();
    console.log();
  }

  rl.close();
}

main().catch(async (e) => {
  console.error("💥 Fatal error:", e);
  await saveConversation();
  process.exit(1);
});