let input = "";
for await (const chunk of process.stdin) input += chunk;

let report;
try {
  report = JSON.parse(input);
} catch {
  process.stderr.write("OpenClaw runtime inspect did not return JSON\n");
  process.exit(1);
}

const plugin = report?.plugin;
const expectedId = "open-android-intelligence-gateway";
const problems = [];
if (plugin?.id !== expectedId) problems.push("plugin id mismatch");
if (plugin?.status !== "loaded") problems.push(`plugin status is ${String(plugin?.status)}`);
if (!plugin?.channelIds?.includes(expectedId)) problems.push("channel registration missing");
if (!plugin?.toolNames?.includes("open_android_device")) problems.push("device tool registration missing");
if (!Array.isArray(report?.diagnostics) || report.diagnostics.length !== 0) {
  problems.push("plugin diagnostics are present or missing");
}

if (problems.length > 0) {
  process.stderr.write(`OpenClaw runtime smoke failed: ${problems.join(", ")}\n`);
  process.exit(1);
}

process.stdout.write(`OpenClaw runtime smoke passed: ${expectedId}\n`);
