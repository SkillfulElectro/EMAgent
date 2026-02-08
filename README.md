# EMAgent

**EMAgent** is a lightweight command-line AI agent that connects to any OpenAI-compatible API. It provides built-in tools for file operations, shell commands, and scheduled wake-ups.

## Features

- **File Operations**: Read, write, and edit files with line-range support
- **Shell Commands**: Execute system commands with timeout protection
- **Scheduled Wake-ups**: Set timers for delayed model responses
- **Conversation Persistence**: Save and resume conversations
- **Context Management**: Automatic detection of context window limits with summarization option
- **Streaming Responses**: Real-time output with reasoning and tool call visibility

## Requirements

- Node.js 18.0.0 or higher (uses built-in `fetch`)

## Installation

```bash
git clone https://github.com/skillfulelectro/emagent.git
cd emagent
npm link  # Optional: makes 'emagent' available globally
```

## Usage

```bash
node EMAgent.js [options]
# or if globally linked:
emagent [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--host <addr>` | LM API host | `localhost` |
| `--port <num>` | LM API port | `1234` |
| `--model <name>` | Model name | `gpt-oss-20b` |
| `--temp <float>` | Temperature | `0.7` |
| `--max-tokens <num>` | Max tokens (-1 = unlimited) | `-1` |
| `--max-history <num>` | Max conversation entries (-1 = unlimited) | `-1` |
| `--context-window <num>` | Context window size in tokens | `128000` |
| `--tool-timeout <ms>` | Tool execution timeout | `30000` |
| `--save <file>` | Save/load conversation file | — |
| `-h, --help` | Show help | — |

### Environment Variables

All options can be set via environment variables with the `EMAGENT_` prefix:

```bash
export EMAGENT_LM_HOST=api.example.com
export EMAGENT_LM_PORT=8080
export EMAGENT_MODEL=gpt-4
```

### In-Chat Commands

| Command | Description |
|---------|-------------|
| `exit` / `quit` | Exit the agent (saves if --save specified) |
| `save` | Manually save conversation |
| `clear` | Clear conversation history |
| `tokens` | Show estimated token usage |

## Available Tools

### `read_file`
Read text file contents with optional line range.
```
path: string (required)
start_line: integer (optional, 0-based)
end_line: integer (optional, exclusive)
```

### `write_file`
Write or append text to a file.
```
path: string (required)
content: string
encoding: "utf8" | "ascii" | "base64"
append: boolean (default: false)
```

### `edit_file`
Find and replace text in a file. Returns the number of replacements made.
```
path: string (required)
find: string (required, exact match)
replace: string (required)
```

### `exec_shell`
Execute a shell command with timeout protection.
```
command: string (required)
```

### `set_time_out`
Schedule a wake-up notification after a delay.
```
time: number (milliseconds)
```

## Examples

### Basic Usage
```bash
node EMAgent.js --host localhost --port 1234
```

### With Conversation Persistence
```bash
node EMAgent.js --save conversation.json
# Resume later with the same command
```

### Custom Model and Settings
```bash
node EMAgent.js \
  --model gpt-4 \
  --temp 0.5 \
  --context-window 32000 \
  --tool-timeout 60000
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      EMAgent                            │
├─────────────────────────────────────────────────────────┤
│  User Input → Conversation → LM API (streaming)        │
│       ↓                           ↓                     │
│  Commands ←─────────────── Tool Calls                  │
│  (exit/save/clear)         (exec_shell, read_file...)  │
│       ↓                           ↓                     │
│  Context Manager ←──────── Tool Results                │
│  (token tracking,                 ↓                     │
│   summarization)           Loop until no tools         │
└─────────────────────────────────────────────────────────┘
```

## License

MIT
