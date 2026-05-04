#!/usr/bin/env bun

/**
 * tmx — thin terminal orchestration CLI for Claude Code agent coordination
 *
 * Dual backend: auto-detects cmux (native CLI via Unix socket) or tmux.
 * Zero dependencies, JSON output, ~10-30ms per operation.
 */

// ── Help ────────────────────────────────────────────────────────────────────

const HELP = `\
tmx — terminal orchestrator for Claude Code agent coordination

USAGE
  tmx <command> [options]

COMMANDS
  new         -s <name> [-d] [cmd...]      Create workspace
  open        -t <target>                    Focus/switch to workspace
  list        [target]                       List workspaces/panes as JSON
  has         -t <target>                    Check if target exists
  kill        -t <target>                    Close workspace/pane
  split       -t <target> -h|-v             Split pane
  resize      -t <target> -U|-D|-L|-R <n>  Resize pane
  send        -t <target> <cmd...>           Send command (+ Enter)
  send-keys   -t <target> <keys...>          Send raw keystrokes
  capture     -t <target> [--raw]            Capture visible area
  capture-full -t <target> [--raw]           Capture full scrollback
  wait        -t <target> -p <pat> [-T <s>] [-i <ms>]  Poll until pattern
  broadcast   -t <target> <cmd...>           Send to all panes
  snapshot    -t <target>                    Export layout as JSON

TARGET FORMAT
  name                    Workspace/session name
  name:panel              Specific panel
  name:panel.surface      Specific surface

OUTPUT
  All commands emit JSON. Use --raw on capture|full for plain text.
  Backend: cmux (when inside cmux) or tmux (fallback).
`;

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkspaceInfo {
  name: string;
  panes: PaneInfo[];
}

interface PaneInfo {
  id: string;
  type: string;
  title: string;
  active: boolean;
  cwd: string;
}

// ── Utilities ────────────────────────────────────────────────────────────────

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const isCmux = !!(process.env.CMUX_WORKSPACE_ID || process.env.CMUX_SURFACE_ID);

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(proc.stdout).trim(),
    stderr: dec.decode(proc.stderr).trim(),
    exitCode: proc.exitCode,
  };
}

function tmux(args: string[]): ReturnType<typeof run> {
  return run(["tmux", ...args]);
}

function cmux(args: string[]): ReturnType<typeof run> {
  return run([CMUX_BIN, ...args]);
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
  first() { return this.positional[0]; }
}

// Split target like "name:panel.surface" or "name:panel" or "name"
function parseTarget(raw: string) {
  const parts = raw.split(":");
  const name = parts[0] || "";
  let panel: string | undefined, surface: string | undefined;
  if (parts[1]) {
    const ps = parts[1].split(".");
    panel = ps[0];
    surface = ps[1];
  }
  return { name, panel, surface };
}

// ── Cmux Helpers ─────────────────────────────────────────────────────────────

// Parse cmux pane/surface ref from list output
// Format: "* pane:29  [1 surface]  [focused]" or "  surface:35"
function parsePaneRef(line: string): string | null {
  const m = line.match(/(pane:\d+|surface:\d+)/);
  return m ? m[1] : null;
}

// Parse cmux workspace ref from list-workspaces output line
// Format: "* workspace:10  ✳ name  [selected]" or "  workspace:11  name"
function parseWorkspaceRef(line: string): string | null {
  const m = line.match(/(workspace:\d+)/);
  return m ? m[1] : null;
}

function cmuxWorkspaceArg(target: string): string[] {
  const { name } = parseTarget(target);
  if (/^workspace:\d+$/.test(name)) return ["--workspace", name];
  const r = cmux(["list-workspaces"]);
  if (r.exitCode === 0) {
    for (const line of r.stdout.split("\n")) {
      if (line.includes(name)) {
        const ref = parseWorkspaceRef(line);
        if (ref) return ["--workspace", ref];
      }
    }
  }
  return ["--workspace", name];
}

function cmuxSurfaceArg(target: string): string[] {
  const { surface } = parseTarget(target);
  if (surface) return ["--surface", surface];
  return [];
}

// ── Commands: new ────────────────────────────────────────────────────────────

async function cmdNew(a: Args) {
  const name = a.opt("-s");
  if (!name) die("Missing -s <name>");

  if (isCmux) {
    const r = cmux(["new-workspace", "--name", name]);
    if (r.exitCode !== 0) die(r.stderr || "Failed to create workspace");
    json({ ok: true, backend: "cmux", name });
  } else {
    const detached = a.flag("-d");
    const cmd = a.rest();
    const tArgs = ["new-session"];
    if (detached) tArgs.push("-d");
    tArgs.push("-s", name);
    if (cmd.length > 0) tArgs.push(...cmd);
    const r = tmux(tArgs);
    if (r.exitCode !== 0) die(r.stderr || "Failed to create session");
    json({ ok: true, backend: "tmux", name, detached });
  }
}

// ── Commands: open ───────────────────────────────────────────────────────────

async function cmdOpen(a: Args) {
  const target = a.opt("-t") || a.first();
  if (!target) die("Missing -t <target>");

  if (isCmux) {
    const r = cmux(["select-workspace", ...cmuxWorkspaceArg(target)]);
    if (r.exitCode !== 0) die(r.stderr || `Workspace not found: ${target}`);
    json({ ok: true, backend: "cmux", target });
  } else {
    const has = tmux(["has-session", "-t", target]);
    if (has.exitCode !== 0) die(`Session not found: ${target}`);
    const script = `tell application "Terminal" to do script "tmux attach -t ${target}"`;
    const r = run(["osascript", "-e", script]);
    if (r.exitCode !== 0) {
      json({ ok: false, backend: "tmux", target, hint: `Run: tmux attach -t ${target}` });
      return;
    }
    json({ ok: true, backend: "tmux", target, opened: "Terminal.app" });
  }
}

// ── Commands: list ───────────────────────────────────────────────────────────

async function cmdList(a: Args) {
  const filter = a.first();

  if (isCmux) {
    const wsR = cmux(["list-workspaces"]);
    if (wsR.exitCode !== 0) { json({ workspaces: [] }); return; }

    const workspaces: WorkspaceInfo[] = [];
    for (const wline of wsR.stdout.split("\n").filter(Boolean)) {
      // Parse: "* workspace:10  name  [selected]" or "  workspace:11  name"
      const ref = parseWorkspaceRef(wline);
      if (!ref) continue;

      // Remove leading marker and [selected] suffix, then extract name
      let nameLine = wline.replace(/^\*\s*/, "").replace(/\s*\[selected\]\s*$/, "").trim();
      // Remove the workspace:N prefix
      nameLine = nameLine.replace(/^workspace:\d+\s+/, "").trim();
      const wname = nameLine || ref;

      if (filter && wname !== filter && ref !== filter) continue;

      const panes: PaneInfo[] = [];
      const pR = cmux(["list-panes", "--workspace", ref]);
      if (pR.exitCode === 0) {
        for (const pline of pR.stdout.split("\n").filter(Boolean)) {
          const pParts = pline.split("\t");
          panes.push({
            id: pParts[0] || pline,
            type: pParts[1] || "terminal",
            title: pParts[2] || "",
            active: pParts[3] === "active" || pParts[3] === "true",
            cwd: pParts[4] || "",
          });
        }
      }
      workspaces.push({ name: wname, panes });
    }
    json({ workspaces });
  } else {
    const sessionsR = tmux(["list-sessions", "-F", "#{session_name}"]);
    if (sessionsR.exitCode !== 0) { json({ sessions: [] }); return; }

    const sessions: any[] = [];
    for (const sname of sessionsR.stdout.split("\n").filter(Boolean)) {
      if (filter && sname !== filter) continue;

      const winsR = tmux(["list-windows", "-t", sname, "-F", "#{window_index}\t#{window_name}\t#{window_active}\t#{window_layout}"]);
      if (winsR.exitCode !== 0) continue;

      const windows: any[] = [];
      for (const wline of winsR.stdout.split("\n").filter(Boolean)) {
        const [wi, wn, wa, wl] = wline.split("\t");
        const panesR = tmux(["list-panes", "-t", `${sname}:${wi}`, "-F", "#{pane_index}\t#{pane_active}\t#{pane_title}\t#{pane_current_path}\t#{pane_pid}"]);
        const panes: any[] = [];
        if (panesR.exitCode === 0) {
          for (const pline of panesR.stdout.split("\n").filter(Boolean)) {
            const [pi, pa, pt, pc, pp] = pline.split("\t");
            panes.push({ index: +pi!, active: pa === "1", title: pt, cwd: pc, pid: pp });
          }
        }
        windows.push({ index: +wi!, name: wn, active: wa === "1", layout: wl, panes });
      }
      sessions.push({ name: sname, windows });
    }
    json({ sessions });
  }
}

// ── Commands: has ────────────────────────────────────────────────────────────

async function cmdHas(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  if (isCmux) {
    const r = cmux(["list-workspaces"]);
    const exists = r.exitCode === 0 && r.stdout.includes(target);
    json({ exists, target, backend: "cmux" });
  } else {
    const r = tmux(["has-session", "-t", target]);
    json({ exists: r.exitCode === 0, target, backend: "tmux" });
  }
}

// ── Commands: kill ───────────────────────────────────────────────────────────

async function cmdKill(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  if (isCmux) {
    const r = cmux(["close-workspace", ...cmuxWorkspaceArg(target)]);
    if (r.exitCode !== 0) die(r.stderr || `Failed to close: ${target}`);
    json({ ok: true, backend: "cmux", killed: target });
  } else {
    let r = tmux(["kill-session", "-t", target]);
    if (r.exitCode === 0) { json({ ok: true, backend: "tmux", killed: target }); return; }
    r = tmux(["kill-window", "-t", target]);
    if (r.exitCode === 0) { json({ ok: true, backend: "tmux", killed: target }); return; }
    r = tmux(["kill-pane", "-t", target]);
    if (r.exitCode === 0) { json({ ok: true, backend: "tmux", killed: target }); return; }
    die(`Failed to kill target: ${target}`);
  }
}

// ── Commands: split ──────────────────────────────────────────────────────────

async function cmdSplit(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const dirFlag = a.flag("-h") ? "right" : a.flag("-v") ? "down" : "";
  if (!dirFlag) die("Missing -h or -v");

  if (isCmux) {
    const r = cmux(["new-split", dirFlag, ...cmuxWorkspaceArg(target)]);
    if (r.exitCode !== 0) die(r.stderr || "Split failed");
    json({ ok: true, backend: "cmux", target, direction: dirFlag });
  } else {
    const d = a.flag("-h") ? "-h" : "-v";
    const r = tmux(["split-window", d, "-t", target]);
    if (r.exitCode !== 0) die(r.stderr || "Split failed");
    json({ ok: true, backend: "tmux", target, direction: d });
  }
}

// ── Commands: resize ─────────────────────────────────────────────────────────

async function cmdResize(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const dirFlag = (["-U", "-D", "-L", "-R"] as const).find(f => a.flag(f));
  if (!dirFlag) die("Missing direction: -U, -D, -L, or -R");

  const size = a.rest()[0];
  if (!size || !/^\d+$/.test(size)) die("Missing or invalid size");

  if (isCmux) {
    const r = cmux(["resize-pane", ...cmuxWorkspaceArg(target), dirFlag, "--amount", size]);
    if (r.exitCode !== 0) die(r.stderr || "Resize failed");
    json({ ok: true, backend: "cmux", target, direction: dirFlag, size: +size });
  } else {
    const r = tmux(["resize-pane", "-t", target, dirFlag, size]);
    if (r.exitCode !== 0) die(r.stderr || "Resize failed");
    json({ ok: true, backend: "tmux", target, direction: dirFlag, size: +size });
  }
}

// ── Commands: send ───────────────────────────────────────────────────────────

async function cmdSend(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const cmd = a.rest();
  if (cmd.length === 0) die("Missing command to send");

  if (isCmux) {
    const sendArgs = ["send", ...cmuxWorkspaceArg(target), ...cmuxSurfaceArg(target), cmd.join(" ")];
    const r = cmux(sendArgs);
    if (r.exitCode !== 0) die(r.stderr || "Send failed");
    // cmux send doesn't append Enter, send the Enter key explicitly
    cmux(["send-key", ...cmuxWorkspaceArg(target), ...cmuxSurfaceArg(target), "Enter"]);
    json({ ok: true, backend: "cmux", target, sent: cmd.join(" ") });
  } else {
    const r = tmux(["send-keys", "-t", target, ...cmd, "Enter"]);
    if (r.exitCode !== 0) die(r.stderr || "Send failed");
    json({ ok: true, backend: "tmux", target, sent: cmd.join(" ") });
  }
}

// ── Commands: send-keys ──────────────────────────────────────────────────────

async function cmdSendKeys(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  const keys = a.rest();
  if (keys.length === 0) die("Missing keys");

  if (isCmux) {
    const r = cmux(["send-key", ...cmuxWorkspaceArg(target), ...cmuxSurfaceArg(target), keys.join(" ")]);
    if (r.exitCode !== 0) die(r.stderr || "Send-key failed");
    json({ ok: true, backend: "cmux", target, keys: keys.join(" ") });
  } else {
    const r = tmux(["send-keys", "-t", target, ...keys]);
    if (r.exitCode !== 0) die(r.stderr || "Send-keys failed");
    json({ ok: true, backend: "tmux", target, keys: keys.join(" ") });
  }
}

// ── Commands: capture ────────────────────────────────────────────────────────

async function cmdCapture(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");
  const raw = a.flag("--raw");

  if (isCmux) {
    const r = cmux(["read-screen", ...cmuxWorkspaceArg(target), ...cmuxSurfaceArg(target)]);
    if (r.exitCode !== 0) die(r.stderr || "Capture failed");
    if (raw) { console.log(r.stdout); } else { json({ ok: true, backend: "cmux", target, content: r.stdout }); }
  } else {
    const start = a.opt("-S"), end = a.opt("-E");
    const tArgs = ["capture-pane", "-p", "-t", target];
    if (start) tArgs.push("-S", start);
    if (end) tArgs.push("-E", end);
    const r = tmux(tArgs);
    if (r.exitCode !== 0) die(r.stderr || "Capture failed");
    if (raw) { console.log(r.stdout); } else { json({ ok: true, backend: "tmux", target, content: r.stdout }); }
  }
}

// ── Commands: capture-full ───────────────────────────────────────────────────

async function cmdCaptureFull(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");
  const raw = a.flag("--raw");

  if (isCmux) {
    const r = cmux(["read-screen", ...cmuxWorkspaceArg(target), ...cmuxSurfaceArg(target), "--scrollback"]);
    if (r.exitCode !== 0) die(r.stderr || "Capture-full failed");
    if (raw) { console.log(r.stdout); } else { json({ ok: true, backend: "cmux", target, content: r.stdout }); }
  } else {
    const r = tmux(["capture-pane", "-p", "-t", target, "-S", "-", "-E", "-"]);
    if (r.exitCode !== 0) die(r.stderr || "Capture-full failed");
    if (raw) { console.log(r.stdout); } else { json({ ok: true, backend: "tmux", target, content: r.stdout }); }
  }
}

// ── Commands: wait ───────────────────────────────────────────────────────────

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
    let content: string;
    if (isCmux) {
      const r = cmux(["read-screen", ...cmuxWorkspaceArg(target), ...cmuxSurfaceArg(target), "--scrollback"]);
      content = r.stdout;
    } else {
      const r = tmux(["capture-pane", "-p", "-t", target, "-S", "-", "-E", "-"]);
      content = r.stdout;
    }
    if (content.includes(pattern)) {
      json({ ok: true, target, pattern, elapsed_ms: Date.now() - startTime });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  json({ ok: false, target, pattern, reason: "timeout", timeout_sec: timeout });
  process.exit(1);
}

// ── Commands: broadcast ──────────────────────────────────────────────────────

async function cmdBroadcast(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");
  const cmd = a.rest();
  if (cmd.length === 0) die("Missing command");

  if (isCmux) {
    // Get all surfaces in workspace
    const wsArg = cmuxWorkspaceArg(target);
    const wid = wsArg[1] || target;
    const panesR = cmux(["list-panes", "--workspace", wid]);
    if (panesR.exitCode !== 0) die("No panes found for: " + target);

    // Get all surfaces in workspace
    const surfaces: string[] = [];
    for (const line of panesR.stdout.split("\n").filter(Boolean)) {
      const pref = parsePaneRef(line);
      if (!pref) continue;
      // Get surface for this pane
      const surfR = cmux(["list-pane-surfaces", "--workspace", wid, "--pane", pref]);
      if (surfR.exitCode === 0) {
        for (const sline of surfR.stdout.split("\n").filter(Boolean)) {
          const sref = parsePaneRef(sline); // same regex works for surface:N
          if (sref) surfaces.push(sref);
        }
      }
    }

    const results: string[] = [];
    for (const sid of surfaces) {
      const r = cmux(["send", "--workspace", wid, "--surface", sid, cmd.join(" ")]);
      cmux(["send-key", "--workspace", wid, "--surface", sid, "Enter"]);
      results.push(`${sid}: ${r.exitCode === 0 ? "ok" : r.stderr}`);
    }
    json({ ok: true, backend: "cmux", target, surfaces: surfaces.length, results });
  } else {
    const panesR = tmux(["list-panes", "-t", target, "-F", "#{session_name}:#{window_index}.#{pane_index}"]);
    if (panesR.exitCode !== 0) die("No panes found for: " + target);

    const panes = panesR.stdout.split("\n").filter(Boolean);
    const results: string[] = [];
    for (const pane of panes) {
      const r = tmux(["send-keys", "-t", pane, ...cmd, "Enter"]);
      results.push(`${pane}: ${r.exitCode === 0 ? "ok" : r.stderr}`);
    }
    json({ ok: true, backend: "tmux", target, panes: panes.length, results });
  }
}

// ── Commands: snapshot ───────────────────────────────────────────────────────

async function cmdSnapshot(a: Args) {
  const target = a.opt("-t");
  if (!target) die("Missing -t <target>");

  if (isCmux) {
    const r = cmux(["tree", "--workspace", target]);
    json({ backend: "cmux", target, tree: r.stdout || "(empty)" });
  } else {
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
    json({ backend: "tmux", target, windows });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  // Verify at least one backend is available
  if (isCmux) {
    const check = cmux(["ping"]);
    if (check.exitCode !== 0) die("cmux daemon not reachable. Is cmux running?");
  } else {
    const check = tmux(["-V"]);
    if (check.exitCode !== 0) die("tmux not found. Install: brew install tmux");
  }

  const cmd = args[0]!;
  const a = new Args(args.slice(1));

  switch (cmd) {
    case "new":           return cmdNew(a);
    case "open":          return cmdOpen(a);
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
    default:
      die(`Unknown command: ${cmd}\nRun 'tmx --help' for usage.`);
  }
}

main().catch(e => {
  json({ error: e.message || String(e) });
  process.exit(1);
});
