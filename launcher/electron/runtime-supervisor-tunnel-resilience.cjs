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
  controlPlaneProxyHealthFromInventory,
  installTunnelResiliencePatch,
};
