# tmx

**Thin tmux orchestration CLI for AI agent coordination.**

~320 lines of TypeScript. Zero dependencies. JSON output. ~10-30ms per operation.

## Why?

cmux MCP's chain: `Claude Code → JSON-RPC → WebSocket → Node daemon → tmux socket → tmux server`. Each layer adds overhead — capture pane takes 300-800ms.

tmx's chain: `Claude Code → Bash → tmux`. No daemon, no MCP, no WebSocket. Direct tmux socket calls.

## How to use

```bash
bun run tmx.ts --help
```

### With Claude Code

Use the `Bash` tool directly — no MCP registration needed:

```bash
# Create a 3-pane workspace
tmx new -s feature-x -d
tmx split -t feature-x:0 -v
tmx split -t feature-x:0.0 -h

# Run Claude in each pane
tmx send -t feature-x:0.0 "claude -- implement auth"
tmx send -t feature-x:0.1 "claude -- implement api"
tmx send -t feature-x:0.2 "claude -- write tests"

# Wait for completion
tmx wait -t feature-x:0.0 -p "Done" -T 300
tmx capture -t feature-x:0.0 --raw
```

## Commands

| Command | Description |
|---------|-------------|
| `new -s <name> [-d]` | Create session |
| `list [session]` | List sessions/windows/panes |
| `has -t <target>` | Check if target exists |
| `kill -t <target>` | Kill session/window/pane |
| `split -t <target> -h\|-v` | Split pane |
| `resize -t <target> -U\|-D\|-L\|-R <n>` | Resize pane |
| `send -t <target> <cmd...>` | Send command (+ Enter) |
| `send-keys -t <target> <keys...>` | Send raw keystrokes |
| `capture -t <target>` | Capture visible area |
| `capture-full -t <target>` | Capture full scrollback |
| `wait -t <target> -p <pat> [-T <s>]` | Poll until pattern |
| `broadcast -t <target> <cmd...>` | Send to all panes |
| `snapshot -t <session>` | Export session layout |
| `restore <json-or-file>` | Restore from snapshot |

## Requirements

- [Bun](https://bun.sh) (v1.0+)
- [tmux](https://github.com/tmux/tmux)
