#!/usr/bin/env bun

/**
 * tmx — thin tmux orchestration CLI for Claude Code agent coordination
 * ~15 commands, zero dependencies, JSON output, ~10-30ms per operation.
 *
 * Link: pm2 → tmux socket → no daemon, no MCP, no WebSocket overhead.
 */

// ── Help ────────────────────────────────────────────────────────────────────

const HELP = `\
tmx — thin tmux wrapper for Claude Code agent orchestration

USAGE
  tmx <command> [options]

COMMANDS
  new         -s <name> [-d] [cmd...]      Create session (detached with -d)
  list        [session]                      List sessions/windows/panes as JSON
  has         -t <target>                    Check if target exists
  kill        -t <target>                    Kill session/window/pane
  split       -t <target> -h|-v             Split pane horizontally/vertically
  resize      -t <target> -U|-D|-L|-R <n>  Resize pane by n cells
  send        -t <target> <cmd...>           Send command to pane (+ Enter)
  send-keys   -t <target> <keys...>          Send raw keystrokes (C-c, C-d, etc.)
  capture     -t <target> [-S <n>] [-E <n>] [--raw]  Capture visible area
  capture-full -t <target> [--raw]           Capture full scrollback
  wait        -t <target> -p <pat> [-T <s>] [-i <ms>]  Poll until pattern
  broadcast   -t <target> <cmd...>           Send to all panes in target
  snapshot    -t <session>                   Export session layout as JSON
  restore     <json-or-file>                 Restore from snapshot JSON

TARGET FORMAT
  session                e.g. work
  session:window         e.g. work:0
  session:window.pane    e.g. work:0.1

OUTPUT
  All commands emit JSON. Use --raw on capture|full for plain text.
  Exit 0 on success, non-zero on failure.
`;

// ── Types ────────────────────────────────────────────────────────────────────

interface SessionInfo {
  name: string;
  windows: WindowInfo[];
}

interface WindowInfo {
  index: number;
  name: string;
  active: boolean;
  layout: string;
  panes: PaneInfo[];
}

interface PaneInfo {
  index: number;
  active: boolean;
  title: string;
  cwd: string;
  pid: string;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function tmux(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(proc.stdout).trim(),
    stderr: dec.decode(proc.stderr).trim(),
    exitCode: proc.exitCode,
  };
}

function json<T>(data: T): void {
  console.log(JSON.stringify(data, null, 2));
}

function die(msg: string, code = 1): never {
  json({ error: msg });
  process.exit(code);
}

// ── Args parser ──────────────────────────────────────────────────────────────

class Args {
  flags = new Set<string>();
  opts = new Map<string, string>();
  positional: string[] = [];

  constructor(args: string[]) {
    let i = 0;
    while (i < args.length) {
      const a = args[i]!;
      if (a === "-t" || a === "-s" || a === "-p" || a === "-S" || a === "-E" || a === "-T" || a === "-i") {
        this.opts.set(a, args[i + 1] || "");
        i += 2;
      } else if (a.startsWith("-")) {
        this.flags.add(a);
        i++;
      } else {
        this.positional = args.slice(i);
        break;
      }
    }
  }

  flag(name: string) { return this.flags.has(name); }
  opt(name: string) { return this.opts.get(name); }
  rest() { return this.positional; }
}

function parseTarget(raw: string): { session: string; window?: string; pane?: string } {
  const parts = raw.split(":");
  const session = parts[0];
  if (!session) throw new Error(`Invalid target: ${raw}`);
  let window: string | undefined, pane: string | undefined;
  if (parts[1]) {
    const wp = parts[1].split(".");
    window = wp[0];
    pane = wp[1];
  }
  return { session, window, pane };
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdNew(a: Args) {
  const session = a.opt("-s");
  if (!session) die("Missing -s <session-name>");

  const detached = a.flag("-d");
  const cmd = a.rest();

  const tArgs = ["new-session"];
  if (detached) tArgs.push("-d");
  tArgs.push("-s", session);
  if (cmd.length > 0) tArgs.push(...cmd);

  const r = tmux(tArgs);
  if (r.exitCode !== 0) die(r.stderr || "Failed to create session");
  json({ ok: true, session, detached });
}

async function cmdList(a: Args) {
  const rest = a.rest();
  const filter = rest[0];

  const sessionsR = tmux(["list-sessions", "-F", "#{session_name}"]);
  if (sessionsR.exitCode !== 0) { json({ sessions: [] }); return; }

  const sessions: SessionInfo[] = [];
  for (const sname of sessionsR.stdout.split("\n").filter(Boolean)) {
    if (filter && sname !== filter) continue;

    const winsR = tmux(["list-windows", "-t", sname, "-F", "#{window_index}\t#{window_name}\t#{window_active}\t#{window_layout}"]);
    if (winsR.exitCode !== 0) continue;

    const windows: WindowInfo[] = [];
    for (const wline of winsR.stdout.split("\n").filter(Boolean)) {
      const [wi, wn, wa, wl] = wline.split("\t");

      const panesR = tmux(["list-panes", "-t", `${sname}:${wi}`, "-F", "#{pane_index}\t#{pane_active}\t#{pane_title}\t#{pane_current_path}\t#{pane_pid}"]);
      const panes: PaneInfo[] = [];
      if (panesR.exitCode === 0) {
        for (const pline of panesR.stdout.split("\n").filter(Boolean)) {
          const [pi, pa, pt, pc, pp] = pline.split("\t");
          panes.push({ index: +pi!, active: pa === "1", title: pt || "", cwd: pc || "", pid: pp || "" });
        }
      }
      windows.push({ index: +wi!, name: wn || "", active: wa === "1", layout: wl || "", panes });
    }
    sessions.push({ name: sname, windows });
  }
  json({ sessions });
}

async function cmdHas(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const { session, window } = parseTarget(target);

  const r = tmux(["has-session", "-t", session]);
  if (r.exitCode !== 0) { json({ exists: false, target }); return; }

  if (window) {
    const wr = tmux(["list-windows", "-t", session, "-F", "#{window_index}"]);
    if (!wr.stdout.split("\n").includes(window)) { json({ exists: false, target }); return; }
  }
  json({ exists: true, target });
}

async function cmdKill(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  let r = tmux(["kill-session", "-t", target]);
  if (r.exitCode === 0) { json({ ok: true, killed: target }); return; }
  r = tmux(["kill-window", "-t", target]);
  if (r.exitCode === 0) { json({ ok: true, killed: target }); return; }
  r = tmux(["kill-pane", "-t", target]);
  if (r.exitCode === 0) { json({ ok: true, killed: target }); return; }
  die(`Failed to kill target: ${target}`);
}

async function cmdSplit(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const direction = a.flag("-h") ? "-h" : a.flag("-v") ? "-v" : "";
  if (!direction) die("Missing -h or -v");

  const r = tmux(["split-window", direction, "-t", target]);
  if (r.exitCode !== 0) die(r.stderr || "Split failed");
  json({ ok: true, target, direction });
}

async function cmdResize(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const dirFlag = ["-U", "-D", "-L", "-R"].find(f => a.flag(f));
  if (!dirFlag) die("Missing direction: -U, -D, -L, or -R");

  const rest = a.rest();
  const size = rest[0];
  if (!size || !/^\d+$/.test(size)) die("Missing or invalid size (number of cells)");

  const r = tmux(["resize-pane", "-t", target, dirFlag, size]);
  if (r.exitCode !== 0) die(r.stderr || "Resize failed");
  json({ ok: true, target, direction: dirFlag, size: +size });
}

async function cmdSend(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const cmd = a.rest();
  if (cmd.length === 0) die("Missing command to send");

  const r = tmux(["send-keys", "-t", target, ...cmd, "Enter"]);
  if (r.exitCode !== 0) die(r.stderr || "Send failed");
  json({ ok: true, target, sent: cmd.join(" ") });
}

async function cmdSendKeys(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const keys = a.rest();
  if (keys.length === 0) die("Missing keys");

  const r = tmux(["send-keys", "-t", target, ...keys]);
  if (r.exitCode !== 0) die(r.stderr || "Send-keys failed");
  json({ ok: true, target, keys: keys.join(" ") });
}

async function cmdCapture(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const start = a.opt("-S");
  const end = a.opt("-E");
  const raw = a.flag("--raw");

  const tArgs = ["capture-pane", "-p", "-t", target];
  if (start) tArgs.push("-S", start);
  if (end) tArgs.push("-E", end);

  const r = tmux(tArgs);
  if (r.exitCode !== 0) die(r.stderr || "Capture failed");

  if (raw) { console.log(r.stdout); } else { json({ ok: true, target, content: r.stdout }); }
}

async function cmdCaptureFull(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const raw = a.flag("--raw");

  const r = tmux(["capture-pane", "-p", "-t", target, "-S", "-", "-E", "-"]);
  if (r.exitCode !== 0) die(r.stderr || "Capture-full failed");

  if (raw) { console.log(r.stdout); } else { json({ ok: true, target, content: r.stdout }); }
}

async function cmdWait(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const pattern = a.opt("-p");
  if (!pattern) die("Missing -p <pattern>");

  const timeout = +(a.opt("-T") || "30");
  const interval = +(a.opt("-i") || "500");

  const deadline = Date.now() + timeout * 1000;
  const startTime = Date.now();

  while (Date.now() < deadline) {
    const r = tmux(["capture-pane", "-p", "-t", target, "-S", "-", "-E", "-"]);
    if (r.exitCode === 0 && r.stdout.includes(pattern)) {
      json({ ok: true, target, pattern, elapsed_ms: Date.now() - startTime });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  json({ ok: false, target, pattern, reason: "timeout", timeout_sec: timeout });
  process.exit(1);
}

async function cmdBroadcast(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const cmd = a.rest();
  if (cmd.length === 0) die("Missing command");

  const panesR = tmux(["list-panes", "-t", target, "-F", "#{session_name}:#{window_index}.#{pane_index}"]);
  if (panesR.exitCode !== 0) die("No panes found for: " + target);

  const panes = panesR.stdout.split("\n").filter(Boolean);
  const results: string[] = [];

  for (const pane of panes) {
    const r = tmux(["send-keys", "-t", pane, ...cmd, "Enter"]);
    results.push(`${pane}: ${r.exitCode === 0 ? "ok" : r.stderr}`);
  }

  json({ ok: true, target, panes: panes.length, results });
}

async function cmdSnapshot(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <session>");

  const winsR = tmux(["list-windows", "-t", target, "-F", "#{window_index}\t#{window_name}\t#{window_layout}"]);
  if (winsR.exitCode !== 0) die("Session not found: " + target);

  const windows: any[] = [];
  for (const wline of winsR.stdout.split("\n").filter(Boolean)) {
    const [wi, wn, wl] = wline.split("\t");

    const panesR = tmux(["list-panes", "-t", `${target}:${wi}`, "-F", "#{pane_index}\t#{pane_current_path}\t#{pane_current_command}"]);
    const panes: any[] = [];
    if (panesR.exitCode === 0) {
      for (const pline of panesR.stdout.split("\n").filter(Boolean)) {
        const [pi, pc, pcmd] = pline.split("\t");
        panes.push({ index: +pi!, cwd: pc, command: pcmd });
      }
    }
    windows.push({ index: +wi!, name: wn, layout: wl, panes });
  }

  json({ session: target, windows });
}

async function cmdRestore(a: Args) {
  const rest = a.rest();
  if (rest.length === 0) die("Missing snapshot JSON or file path");

  const input = rest.join(" ");
  let snapshot: any;

  try {
    snapshot = JSON.parse(input);
  } catch {
    try {
      snapshot = JSON.parse(await Bun.file(input).text());
    } catch {
      die("Invalid snapshot: not valid JSON and not a readable file");
    }
  }

  if (!snapshot.session || !Array.isArray(snapshot.windows)) {
    die("Invalid snapshot format: need { session, windows }");
  }

  let r = tmux(["new-session", "-d", "-s", snapshot.session]);
  if (r.exitCode !== 0) die("Failed to create session: " + r.stderr);

  for (let wi = 0; wi < snapshot.windows.length; wi++) {
    const win = snapshot.windows[wi];

    if (wi > 0) {
      r = tmux(["new-window", "-t", snapshot.session, "-n", win.name || `win${wi}`]);
      if (r.exitCode !== 0) continue;
    }

    const paneCount = win.panes?.length || 1;
    for (let pi = 1; pi < paneCount; pi++) {
      const pane = win.panes[pi];
      tmux(["split-window", "-t", `${snapshot.session}:${win.index}`, "-c", pane?.cwd || process.env.HOME || "/"]);
    }

    if (win.layout) {
      tmux(["select-layout", "-t", `${snapshot.session}:${win.index}`, win.layout]);
    }
  }

  json({ ok: true, restored: snapshot.session, windows: snapshot.windows.length });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const check = tmux(["-V"]);
  if (check.exitCode !== 0) die("tmux not found. Install: brew install tmux");

  const cmd = args[0]!;
  const a = new Args(args.slice(1));

  switch (cmd) {
    case "new":           return cmdNew(a);
    case "list":          return cmdList(a);
    case "has":           return cmdHas(a);
    case "kill":          return cmdKill(a);
    case "split":         return cmdSplit(a);
    case "resize":        return cmdResize(a);
    case "send":          return cmdSend(a);
    case "send-keys":     return cmdSendKeys(a);
    case "capture":       return cmdCapture(a);
    case "capture-full":  return cmdCaptureFull(a);
    case "wait":          return cmdWait(a);
    case "broadcast":     return cmdBroadcast(a);
    case "snapshot":      return cmdSnapshot(a);
    case "restore":       return cmdRestore(a);
    default:
      die(`Unknown command: ${cmd}\nRun 'tmx --help' for usage.`);
  }
}

main().catch(e => {
  json({ error: e.message || String(e) });
  process.exit(1);
});
