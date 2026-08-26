const assert = require("node:assert/strict");
const test = require("node:test");

const {
  controlPlaneProxyHealthFromInventory,
  installTunnelResiliencePatch,
} = require("../electron/runtime-supervisor-tunnel-resilience.cjs");

function inventory(healthState) {
  return JSON.stringify({
    entries: [{
      alias: "codex-chatgpt-web",
      live_runtime: {
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

test("monitor preserves green local state when control plane is healthy", async () => {
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
