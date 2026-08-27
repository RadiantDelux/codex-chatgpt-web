const EXPECTED_TUNNEL_CLIENT_VERSION = "0.0.13";

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

function staleRuntimeStopError(result) {
  const output = typeof result?.output === "string" ? result.output : "";
  const safeOutput = output
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .slice(0, 500);
  return `failed to stop stale tunnel-client runtime${safeOutput ? `: ${safeOutput}` : ""}`;
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
      }

      if (liveVersion?.statusKnown && liveVersion.version !== EXPECTED_TUNNEL_CLIENT_VERSION) {
        this.logger?.warn?.("runtime.tunnel_version_mismatch", {
          liveVersion: liveVersion.version,
          expectedVersion: EXPECTED_TUNNEL_CLIENT_VERSION,
        });
        this.stopTunnelMonitor?.();
        const stopped = await this.runTunnelStopCommand(config);
        if (stopped?.code !== 0) {
          throw new Error(staleRuntimeStopError(stopped));
        }
        if (typeof this.waitForTunnelStopped === "function") {
          await this.waitForTunnelStopped(config);
        }
        this.tunnel = null;
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
  installTunnelResiliencePatch,
};
