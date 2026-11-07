import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root } from "./config.mjs";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
// macOS 用 LaunchAgent 替代 Windows 计划任务；Label 固定，便于 status/uninstall 定位
const LAUNCH_LABEL = "com.douyin.knowledge.sync";

function launchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
}

function findNodeBinary() {
  // 打包版：dok-runtime/node/bin/node；开发版退回当前 node
  const bundled = path.join(path.dirname(root), "node", IS_WIN ? "node.exe" : path.join("bin", "node"));
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

function runLaunchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf8", timeout: 60000 });
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}

function isLoaded() {
  const out = runLaunchctl(["list"]);
  const text = String(out.stdout || "");
  return text.split(/\r?\n/u).some((line) => line.trim().split(/\s+/u).at(-1) === LAUNCH_LABEL);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildPlist(config, options = {}) {
  const nodeBinary = findNodeBinary();
  const syncScript = path.join(root, "scripts", "run-sync.mjs");
  const logsDir = path.join(root, "var", "logs");
  const dailyTime = String(options.dailyTime || config.scheduleDaily || "").trim();
  let scheduleXml;
  if (dailyTime) {
    const [hour, minute] = (dailyTime.match(/^\d{1,2}:\d{2}$/u) ? dailyTime : "08:00")
      .split(":")
      .map((value) => Number(value));
    scheduleXml = `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>`;
  } else {
    scheduleXml = `  <key>StartInterval</key><integer>${Number(config.scheduleMinutes) * 60}</integer>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBinary)}</string>
    <string>${xmlEscape(syncScript)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(logsDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(logsDir, "launchd.err.log"))}</string>
  <key>RunAtLoad</key><false/>
${scheduleXml}
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
`;
}

function macTaskInfo() {
  const plist = launchAgentPath();
  const installed = fs.existsSync(plist);
  let owned = false;
  let scheduleText = "not installed";
  if (installed) {
    try {
      const content = fs.readFileSync(plist, "utf8");
      owned = content.includes("run-sync.mjs");
      const hour = (content.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/u) || [])[1];
      const minute = (content.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/u) || [])[1];
      const interval = (content.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/u) || [])[1];
      if (hour !== undefined && minute !== undefined) {
        scheduleText = `daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      } else if (interval !== undefined) {
        scheduleText = `every ${Math.round(Number(interval) / 60)} minutes`;
      }
    } catch {
      owned = false;
    }
  }
  const loaded = installed && isLoaded();
  return { installed, owned, loaded, task: LAUNCH_LABEL, scheduleText, plist };
}

function macSchedulerAction(config, action, options = {}) {
  const info = macTaskInfo();
  if (action === "install") {
    if (info.installed) {
      throw new Error(`LaunchAgent already exists: ${LAUNCH_LABEL}. Inspect it with schedule status; uninstall it explicitly before reinstalling.`);
    }
    fs.mkdirSync(path.dirname(info.plist), { recursive: true });
    fs.mkdirSync(path.join(root, "var", "logs"), { recursive: true });
    fs.writeFileSync(info.plist, buildPlist(config, options), "utf8");
    runLaunchctl(["load", "-w", info.plist]);
    const after = macTaskInfo();
    return {
      action,
      installed: true,
      enabled: true,
      task: LAUNCH_LABEL,
      schedule: after.scheduleText,
      rollbackCommand: "node ./src/cli.mjs schedule uninstall",
    };
  }
  if (action === "status") {
    return {
      action,
      installed: info.installed,
      owned: info.owned,
      task: LAUNCH_LABEL,
      everyMinutes: config.scheduleMinutes,
      detail: info.installed
        ? (info.owned ? (info.loaded ? "available" : "installed but not loaded") : "name collision: LaunchAgent is not owned by this workflow")
        : "not installed",
      schedule: info.scheduleText,
      rollbackCommand: "node ./src/cli.mjs schedule uninstall",
    };
  }
  if (action === "run") {
    if (!info.installed || !info.owned) throw new Error(`Refusing to run an unowned LaunchAgent: ${LAUNCH_LABEL}`);
    runLaunchctl(["kickstart", "-k", `gui/${currentUid()}/${LAUNCH_LABEL}`]);
    return { action, task: LAUNCH_LABEL, started: true };
  }
  if (action === "disable") {
    if (!info.installed || !info.owned) throw new Error(`Refusing to disable an unowned LaunchAgent: ${LAUNCH_LABEL}`);
    runLaunchctl(["unload", "-w", info.plist]);
    return { action, task: LAUNCH_LABEL, enabled: false };
  }
  if (action === "enable") {
    if (!info.installed || !info.owned) throw new Error(`Refusing to enable an unowned LaunchAgent: ${LAUNCH_LABEL}`);
    runLaunchctl(["load", "-w", info.plist]);
    return { action, task: LAUNCH_LABEL, enabled: true };
  }
  if (action === "uninstall") {
    if (!info.installed) return { action, task: LAUNCH_LABEL, removed: false };
    if (!info.owned) throw new Error(`Refusing to remove an unowned LaunchAgent: ${LAUNCH_LABEL}`);
    runLaunchctl(["unload", "-w", info.plist]);
    fs.rmSync(info.plist, { force: true });
    return { action, task: LAUNCH_LABEL, removed: true };
  }
  throw new Error("schedule action must be install, status, run, enable, disable, or uninstall");
}

function run(args, allowMissing = false) {
  if (!IS_WIN) throw new Error("Windows Task Scheduler is only available on Windows");
  const result = spawnSync("schtasks.exe", args, { windowsHide: true, shell: false, encoding: "utf8", timeout: 60000 });
  if (result.status !== 0 && !allowMissing) {
    throw new Error(`Task Scheduler command failed with ${result.status}: ${String(result.stderr || result.stdout).replace(/\s+/gu, " ").trim().slice(-500)}`);
  }
  return result;
}

function taskOwnership(config) {
  const result = run(["/Query", "/TN", config.schedulerTaskName, "/XML"], true);
  if (result.status !== 0) return { installed: false, owned: false };
  const script = path.join(root, "scripts", "run-sync.ps1");
  return {
    installed: true,
    owned: String(result.stdout || "").replaceAll("\0", "").toLowerCase().includes(script.toLowerCase()),
  };
}

function winSchedulerAction(config, action, options = {}) {
  const task = config.schedulerTaskName;
  if (action === "install") {
    const existing = taskOwnership(config);
    if (existing.installed) {
      throw new Error(`Scheduled task already exists: ${task}. Inspect it with schedule status; uninstall it explicitly before reinstalling.`);
    }
    const script = path.join(root, "scripts", "run-sync.ps1");
    const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}"`;
    const dailyTime = String(options.dailyTime || config.scheduleDaily || "").trim();
    if (dailyTime) {
      const time = /^\d{1,2}:\d{2}$/u.test(dailyTime) ? dailyTime : "08:00";
      run(["/Create", "/TN", task, "/TR", command, "/SC", "DAILY", "/ST", time, "/RL", "LIMITED", "/F"]);
    } else {
      run(["/Create", "/TN", task, "/TR", command, "/SC", "MINUTE", "/MO", String(config.scheduleMinutes), "/RL", "LIMITED", "/F"]);
    }
    return {
      action,
      installed: true,
      enabled: true,
      task,
      schedule: dailyTime ? `daily at ${dailyTime}` : `every ${config.scheduleMinutes} minutes`,
      rollbackCommand: "node .\\src\\cli.mjs schedule uninstall",
    };
  }
  if (action === "status") {
    const ownership = taskOwnership(config);
    return {
      action,
      installed: ownership.installed,
      owned: ownership.owned,
      task,
      everyMinutes: config.scheduleMinutes,
      detail: ownership.installed ? (ownership.owned ? "available" : "name collision: task is not owned by this workflow") : "not installed",
      rollbackCommand: "node .\\src\\cli.mjs schedule uninstall",
    };
  }
  if (action === "run") {
    const ownership = taskOwnership(config);
    if (!ownership.installed || !ownership.owned) throw new Error(`Refusing to run an unowned scheduled task: ${task}`);
    run(["/Run", "/TN", task]);
    return { action, task, started: true };
  }
  if (action === "disable") {
    const ownership = taskOwnership(config);
    if (!ownership.installed || !ownership.owned) throw new Error(`Refusing to disable an unowned scheduled task: ${task}`);
    run(["/Change", "/TN", task, "/DISABLE"]);
    return { action, task, enabled: false };
  }
  if (action === "enable") {
    const ownership = taskOwnership(config);
    if (!ownership.installed || !ownership.owned) throw new Error(`Refusing to enable an unowned scheduled task: ${task}`);
    run(["/Change", "/TN", task, "/ENABLE"]);
    return { action, task, enabled: true };
  }
  if (action === "uninstall") {
    const ownership = taskOwnership(config);
    if (!ownership.installed) return { action, task, removed: false };
    if (!ownership.owned) throw new Error(`Refusing to remove an unowned scheduled task: ${task}`);
    const result = run(["/Delete", "/TN", task, "/F"]);
    return { action, task, removed: result.status === 0 };
  }
  throw new Error("schedule action must be install, status, run, enable, disable, or uninstall");
}

export function schedulerAction(config, action, options = {}) {
  if (IS_MAC) return macSchedulerAction(config, action, options);
  if (IS_WIN) return winSchedulerAction(config, action, options);
  // Linux：暂不支持定时任务
  if (action === "status") {
    return {
      action,
      installed: false,
      owned: false,
      task: LAUNCH_LABEL,
      detail: "scheduled sync is not supported on this platform",
      rollbackCommand: "",
    };
  }
  throw new Error("Scheduled sync is not supported on this platform");
}
