const path = require("node:path");
const { spawn } = require("node:child_process");
const { tunnelUpgradeInvocation } = require("./runtime-command.cjs");

const EXPECTED_TUNNEL_CLIENT_VERSION = "0.0.13";
const TUNNEL_UPGRADE_TIMEOUT_MS = 120_000;
const MAX_TUNNEL_UPGRADE_OUTPUT_CHARS = 1024 * 1024;

function parsedInventoryEntry(output, alias) {
  if (typeof output !== "string" || !output.trim()) return undefined;
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed.entries)) return undefined;
    return parsed.entries.find(candidate => candidate?.alias === alias);
  } catch {
    return undefined;
  }
}

function controlPlaneProxyHealthFromInventory(output, alias) {
  const entry = parsedInventoryEntry(output, alias);
  const summaries = entry?.live_runtime?.system?.proxy_health;
  if (!Array.isArray(summaries)) {
    return { statusKnown: false, healthy: undefined, state: undefined };
  }
  const controlPlane = summaries.find(summary => summary?.route?.kind === "control_plane");
  const state = typeof controlPlane?.health_state === "string"
    ? controlPlane.health_state
    : undefined;
  if (!state || state === "unknown") {
    return { statusKnown: false, healthy: undefined, state };
  }
  return {
    statusKnown: true,
    healthy: state === "healthy" || state === "direct",
    state,
  };
}

function mainMcpChannelHealthFromInventory(output, alias) {
  const entry = parsedInventoryEntry(output, alias);
  const channels = entry?.live_runtime?.status?.channels;
  if (!Array.isArray(channels)) {
    return { statusKnown: false, healthy: undefined, state: undefined, reason: undefined };
  }
  const main = channels.find(channel => channel?.name === "main");
  if (!main || main.transport_kind !== "stdio") {
    return { statusKnown: false, healthy: undefined, state: undefined, reason: undefined };
  }
  const state = typeof main.probe_status === "string" ? main.probe_status : undefined;
  const reason = typeof main.reason === "string" ? main.reason : undefined;

  // tunnel-client marks the channel disabled when the initial MCP probe fails. Treat only that
  // terminal state as unhealthy; pending/timeout/auth-required remain fail-open because they can
  // recover without restarting the managed runtime.
  if (state === "failed" || (main.enabled === false && reason === "initial mcp probe failed")) {
    return { statusKnown: true, healthy: false, state: state ?? "failed", reason };
  }
  if (main.enabled === true && state === "ok") {
    return { statusKnown: true, healthy: true, state, reason };
  }
  return { statusKnown: false, healthy: undefined, state, reason };
}

function liveTunnelVersionFromInventory(output, alias) {
  const entry = parsedInventoryEntry(output, alias);
  const rawVersion = entry?.live_runtime?.status?.version;
  const version = typeof rawVersion === "string" ? rawVersion.trim() : "";
  if (!version) {
    return { statusKnown: false, version: undefined };
  }
  return { statusKnown: true, version };
}

function tunnelClientVersionFromOutput(output) {
  const match = String(output || "").match(/\b(\d+\.\d+\.\d+)\b/);
  return match
    ? { statusKnown: true, version: match[1] }
    : { statusKnown: false, version: undefined };
}

function redactTunnelDiagnostic(value, maxChars = 500) {
  return String(value || "")
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .slice(0, maxChars);
}

function tunnelRuntimeAbsentOutput(value) {
  return /not found|not running|unknown alias|\balias\b[^\r\n]{0,160}\bis not known\b/i.test(
    String(value || ""),
  );
}

function staleRuntimeStopError(result) {
  const safeOutput = redactTunnelDiagnostic(result?.output);
  return `failed to stop stale tunnel-client runtime${safeOutput ? `: ${safeOutput}` : ""}`;
}

function pathIdentity(value, platform = process.platform) {
  const normalized = platform === "win32" ? path.win32.resolve(value) : path.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function appendBoundedOutput(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length <= MAX_TUNNEL_UPGRADE_OUTPUT_CHARS
    ? next
    : next.slice(-MAX_TUNNEL_UPGRADE_OUTPUT_CHARS);
}

function runControlInvocation(invocation, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", chunk => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr.on("data", chunk => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${label} failed to start: ${error instanceof Error ? error.message : String(error)}`));
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code: Number.isInteger(code) ? code : 1, stdout, stderr });
    });
  });
}

async function runTunnelClientUpgrade(supervisor, config) {
  if (supervisor.runtimeRootProvider) {
    supervisor.installedRuntimeRoot = supervisor.runtimeRootProvider();
  }
  const invocation = tunnelUpgradeInvocation({
    app: supervisor.app,
    sourceRoot: supervisor.sourceRoot,
    installedRuntimeRoot: supervisor.installedRuntimeRoot,
  });
  const result = await runControlInvocation(
    invocation,
    TUNNEL_UPGRADE_TIMEOUT_MS,
    "Tunnel client updater",
  );
  if (result.code !== 0) {
    const detail = redactTunnelDiagnostic(result.stderr || result.stdout, 1_000);
    throw new Error(`Tunnel client updater failed${detail ? `: ${detail}` : ""}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(
      `Tunnel client updater returned invalid output: ${redactTunnelDiagnostic(result.stdout || "[empty]")}`,
    );
  }
  if (parsed?.version !== EXPECTED_TUNNEL_CLIENT_VERSION) {
    throw new Error(
      `Tunnel client updater installed unexpected version ${String(parsed?.version || "unknown")}`,
    );
  }
  if (typeof parsed?.executable !== "string"
    || pathIdentity(parsed.executable) !== pathIdentity(config.tunnel.binaryPath)) {
    throw new Error("Tunnel client updater target does not match the configured tunnel binary");
  }
  return parsed;
}

function installTunnelResiliencePatch(RuntimeSupervisor) {
  if (!RuntimeSupervisor?.prototype) {
    throw new TypeError("RuntimeSupervisor class is required");
  }
  const prototype = RuntimeSupervisor.prototype;
  if (prototype.__tunnelResiliencePatched) return;

  const originalObserveTunnelForMonitor = prototype.observeTunnelForMonitor;
  if (typeof originalObserveTunnelForMonitor !== "function") {
    throw new Error("RuntimeSupervisor tunnel monitor method is unavailable");
  }

  prototype.observeTunnelForMonitor = async function patchedObserveTunnelForMonitor(config) {
    const local = await this.readLocalTunnelHealth();
    if (!local.statusKnown) {
      return await originalObserveTunnelForMonitor.call(this, config);
    }
    if (!local.ready) return local;

    try {
      const inventory = await this.runTunnelCommand(
        config,
        ["runtimes", "cleanup", "--json"],
        5_000,
        "Tunnel deep health probe",
      );
      if (inventory?.code !== 0) return local;

      const alias = config?.tunnel?.alias;
      const liveVersion = liveTunnelVersionFromInventory(inventory.output, alias);
      if (liveVersion.statusKnown && liveVersion.version !== EXPECTED_TUNNEL_CLIENT_VERSION) {
        return {
          ...local,
          ready: false,
          healthy: false,
          state: "degraded",
          detail: `${local.detail}; runtime_version=${liveVersion.version} expected=${EXPECTED_TUNNEL_CLIENT_VERSION}`,
        };
      }

      const proxyHealth = controlPlaneProxyHealthFromInventory(inventory.output, alias);
      if (proxyHealth.statusKnown && !proxyHealth.healthy) {
        return {
          ...local,
          ready: false,
          healthy: false,
          state: "degraded",
          detail: `${local.detail}; control_plane=${proxyHealth.state}`,
        };
      }

      const mcpHealth = mainMcpChannelHealthFromInventory(inventory.output, alias);
      if (mcpHealth.statusKnown && !mcpHealth.healthy) {
        return {
          ...local,
          ready: false,
          healthy: false,
          state: "degraded",
          detail: `${local.detail}; mcp_main=${mcpHealth.state}${mcpHealth.reason ? ` (${mcpHealth.reason})` : ""}`,
        };
      }

      return local;
    } catch (error) {
      this.logger?.warn?.("runtime.tunnel_deep_probe_unavailable", {
        message: error instanceof Error ? error.message : String(error),
      });
      return local;
    }
  };

  const originalStartTunnel = prototype.startTunnel;
  if (typeof originalStartTunnel === "function") {
    prototype.startTunnel = async function patchedStartTunnel(config, ...args) {
      let liveVersion;
      let installedVersion;
      if (config?.mode === "full" && config?.tunnel?.alias) {
        try {
          const inventory = await this.runTunnelCommand(
            config,
            ["runtimes", "cleanup", "--json"],
            5_000,
            "Tunnel runtime version probe",
          );
          if (inventory?.code === 0) {
            liveVersion = liveTunnelVersionFromInventory(inventory.output, config.tunnel.alias);
          }
        } catch (error) {
          this.logger?.warn?.("runtime.tunnel_version_probe_unavailable", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          const binaryVersion = await this.runTunnelCommand(
            config,
            ["--version"],
            10_000,
            "Tunnel client binary version probe",
          );
          if (binaryVersion?.code === 0) {
            installedVersion = tunnelClientVersionFromOutput(binaryVersion.output);
          }
        } catch (error) {
          this.logger?.warn?.("runtime.tunnel_binary_version_probe_unavailable", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const liveMismatch = liveVersion?.statusKnown
        && liveVersion.version !== EXPECTED_TUNNEL_CLIENT_VERSION;
      const installedMismatch = installedVersion?.statusKnown
        && installedVersion.version !== EXPECTED_TUNNEL_CLIENT_VERSION;
      if (liveMismatch || installedMismatch) {
        this.logger?.warn?.("runtime.tunnel_version_mismatch", {
          liveVersion: liveVersion?.version,
          installedVersion: installedVersion?.version,
          expectedVersion: EXPECTED_TUNNEL_CLIENT_VERSION,
        });
        this.stopTunnelMonitor?.();
        const stopped = await this.runTunnelStopCommand(config);
        if (stopped?.code !== 0 && !tunnelRuntimeAbsentOutput(stopped?.output)) {
          throw new Error(staleRuntimeStopError(stopped));
        }
        if (stopped?.code === 0 && typeof this.waitForTunnelStopped === "function") {
          await this.waitForTunnelStopped(config);
        }
        this.tunnel = null;

        const shouldUpgradeBinary = installedMismatch
          || (liveMismatch && !installedVersion?.statusKnown);
        if (shouldUpgradeBinary) {
          const upgraded = typeof this.runTunnelClientUpgrade === "function"
            ? await this.runTunnelClientUpgrade(config)
            : await runTunnelClientUpgrade(this, config);
          this.logger?.info?.("runtime.tunnel_client_upgraded", {
            version: upgraded?.version ?? EXPECTED_TUNNEL_CLIENT_VERSION,
          });
        }
      }

      return await originalStartTunnel.call(this, config, ...args);
    };
  }

  Object.defineProperty(prototype, "__tunnelResiliencePatched", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

module.exports = {
  EXPECTED_TUNNEL_CLIENT_VERSION,
  controlPlaneProxyHealthFromInventory,
  liveTunnelVersionFromInventory,
  mainMcpChannelHealthFromInventory,
  tunnelClientVersionFromOutput,
  installTunnelResiliencePatch,
};
