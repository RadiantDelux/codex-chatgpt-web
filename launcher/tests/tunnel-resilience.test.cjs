const assert = require("node:assert/strict");
const test = require("node:test");

const {
  controlPlaneProxyHealthFromInventory,
  mainMcpChannelHealthFromInventory,
  installTunnelResiliencePatch,
} = require("../electron/runtime-supervisor-tunnel-resilience.cjs");

function inventory(healthState, channel = {
  name: "main",
  enabled: true,
  transport_kind: "stdio",
  probe_status: "ok",
}) {
  return JSON.stringify({
    entries: [{
      alias: "codex-chatgpt-web",
      live_runtime: {
        status: {
          channels: [channel],
        },
        system: {
          proxy_health: [{
            route: { kind: "control_plane" },
            health_state: healthState,
          }],
        },
      },
    }],
  });
}

test("control-plane inventory reports healthy route", () => {
  assert.deepEqual(
    controlPlaneProxyHealthFromInventory(inventory("healthy"), "codex-chatgpt-web"),
    { statusKnown: true, healthy: true, state: "healthy" },
  );
});

test("control-plane inventory reports degraded route", () => {
  assert.deepEqual(
    controlPlaneProxyHealthFromInventory(inventory("degraded"), "codex-chatgpt-web"),
    { statusKnown: true, healthy: false, state: "degraded" },
  );
});

test("unknown or missing proxy health does not cause a false failure", () => {
  assert.equal(
    controlPlaneProxyHealthFromInventory(inventory("unknown"), "codex-chatgpt-web").statusKnown,
    false,
  );
  assert.equal(
    controlPlaneProxyHealthFromInventory(JSON.stringify({ entries: [] }), "codex-chatgpt-web").statusKnown,
    false,
  );
});

test("MCP inventory reports a terminal failed stdio probe", () => {
  assert.deepEqual(
    mainMcpChannelHealthFromInventory(inventory("healthy", {
      name: "main",
      enabled: false,
      transport_kind: "stdio",
      probe_status: "failed",
      reason: "initial mcp probe failed",
    }), "codex-chatgpt-web"),
    {
      statusKnown: true,
      healthy: false,
      state: "failed",
      reason: "initial mcp probe failed",
    },
  );
});

test("MCP inventory keeps non-terminal probe states fail-open", () => {
  for (const probeStatus of ["pending", "timeout", "auth-required"]) {
    assert.equal(
      mainMcpChannelHealthFromInventory(inventory("healthy", {
        name: "main",
        enabled: true,
        transport_kind: "stdio",
        probe_status: probeStatus,
      }), "codex-chatgpt-web").statusKnown,
      false,
    );
  }
});

test("monitor overrides green local probes when control plane is degraded", async () => {
  class FakeSupervisor {
    async readLocalTunnelHealth() {
      return {
        ready: true,
        healthy: true,
        state: "ready",
        statusKnown: true,
        detail: "/healthz returned HTTP 200; /readyz returned HTTP 200",
      };
    }

    async observeTunnelForMonitor() {
      return { ready: true, healthy: true, state: "ready", statusKnown: true };
    }

    async runTunnelCommand() {
      return { code: 0, output: inventory("degraded") };
    }
  }

  installTunnelResiliencePatch(FakeSupervisor);
  const supervisor = new FakeSupervisor();
  const result = await supervisor.observeTunnelForMonitor({
    tunnel: { alias: "codex-chatgpt-web" },
  });

  assert.equal(result.ready, false);
  assert.equal(result.healthy, false);
  assert.equal(result.state, "degraded");
  assert.match(result.detail, /control_plane=degraded/);
});

test("monitor overrides green local probes when the main MCP stdio probe failed", async () => {
  class FakeSupervisor {
    async readLocalTunnelHealth() {
      return {
        ready: true,
        healthy: true,
        state: "ready",
        statusKnown: true,
        detail: "local ready",
      };
    }

    async observeTunnelForMonitor() {
      return { ready: true, healthy: true, state: "ready", statusKnown: true };
    }

    async runTunnelCommand() {
      return {
        code: 0,
        output: inventory("healthy", {
          name: "main",
          enabled: false,
          transport_kind: "stdio",
          probe_status: "failed",
          reason: "initial mcp probe failed",
        }),
      };
    }
  }

  installTunnelResiliencePatch(FakeSupervisor);
  const result = await new FakeSupervisor().observeTunnelForMonitor({
    tunnel: { alias: "codex-chatgpt-web" },
  });

  assert.equal(result.ready, false);
  assert.equal(result.healthy, false);
  assert.equal(result.state, "degraded");
  assert.match(result.detail, /mcp_main=failed/);
});

test("monitor preserves green local state when control plane and MCP channel are healthy", async () => {
  class FakeSupervisor {
    async readLocalTunnelHealth() {
      return {
        ready: true,
        healthy: true,
        state: "ready",
        statusKnown: true,
        detail: "local ready",
      };
    }

    async observeTunnelForMonitor() {
      return { ready: true, healthy: true, state: "ready", statusKnown: true };
    }

    async runTunnelCommand() {
      return { code: 0, output: inventory("healthy") };
    }
  }

  installTunnelResiliencePatch(FakeSupervisor);
  const result = await new FakeSupervisor().observeTunnelForMonitor({
    tunnel: { alias: "codex-chatgpt-web" },
  });

  assert.equal(result.ready, true);
  assert.equal(result.healthy, true);
});
