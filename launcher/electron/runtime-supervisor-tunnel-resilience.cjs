const MCP_STDIO_SEND_INITIALIZED_NOTIFICATION = "true";

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
    const state = typeof controlPlane?.state === "string" ? controlPlane.state : undefined;
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

function installTunnelResiliencePatch(RuntimeSupervisor) {
  if (!RuntimeSupervisor?.prototype) {
    throw new TypeError("RuntimeSupervisor class is required");
  }
  const prototype = RuntimeSupervisor.prototype;
  if (prototype.__tunnelResiliencePatched) return;

  const originalRunTunnelCommand = prototype.runTunnelCommand;
  const originalObserveTunnelForMonitor = prototype.observeTunnelForMonitor;
  if (typeof originalRunTunnelCommand !== "function"
    || typeof originalObserveTunnelForMonitor !== "function") {
    throw new Error("RuntimeSupervisor tunnel methods are unavailable");
  }

  prototype.runTunnelCommand = function patchedRunTunnelCommand(config, args, ...rest) {
    if (!Array.isArray(args) || args[0] !== "runtimes" || args[1] !== "connect") {
      return originalRunTunnelCommand.call(this, config, args, ...rest);
    }
    const previous = process.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION;
    process.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION = MCP_STDIO_SEND_INITIALIZED_NOTIFICATION;
    try {
      return originalRunTunnelCommand.call(this, config, args, ...rest);
    } finally {
      if (previous === undefined) delete process.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION;
      else process.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION = previous;
    }
  };

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
        "Tunnel control-plane health probe",
      );
      if (inventory?.code !== 0) return local;
      const health = controlPlaneProxyHealthFromInventory(inventory.output, config?.tunnel?.alias);
      if (!health.statusKnown || health.healthy) return local;
      return {
        ...local,
        ready: false,
        healthy: false,
        state: "degraded",
        detail: `${local.detail}; control_plane=${health.state}`,
      };
    } catch (error) {
      this.logger?.warn?.("runtime.tunnel_control_plane_probe_unavailable", {
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
  MCP_STDIO_SEND_INITIALIZED_NOTIFICATION,
  controlPlaneProxyHealthFromInventory,
  installTunnelResiliencePatch,
};
