function controlPlaneProxyHealthFromInventory(output, alias) {
  if (typeof output !== "string" || !output.trim()) {
    return { statusKnown: false, healthy: undefined, state: undefined };
  }
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed.entries)) {
      return { statusKnown: false, healthy: undefined, state: undefined };
    }
    const entry = parsed.entries.find(candidate => candidate?.alias === alias);
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
  } catch {
    return { statusKnown: false, healthy: undefined, state: undefined };
  }
}

function mainMcpChannelHealthFromInventory(output, alias) {
  if (typeof output !== "string" || !output.trim()) {
    return { statusKnown: false, healthy: undefined, state: undefined, reason: undefined };
  }
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed.entries)) {
      return { statusKnown: false, healthy: undefined, state: undefined, reason: undefined };
    }
    const entry = parsed.entries.find(candidate => candidate?.alias === alias);
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
  } catch {
    return { statusKnown: false, healthy: undefined, state: undefined, reason: undefined };
  }
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

  Object.defineProperty(prototype, "__tunnelResiliencePatched", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

module.exports = {
  controlPlaneProxyHealthFromInventory,
  mainMcpChannelHealthFromInventory,
  installTunnelResiliencePatch,
};
