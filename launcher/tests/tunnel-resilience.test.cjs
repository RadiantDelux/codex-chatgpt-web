const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EXPECTED_TUNNEL_CLIENT_VERSION,
  controlPlaneProxyHealthFromInventory,
  liveTunnelVersionFromInventory,
  mainMcpChannelHealthFromInventory,
  tunnelClientVersionFromOutput,
  installTunnelResiliencePatch,
} = require("../electron/runtime-supervisor-tunnel-resilience.cjs");

function inventory(healthState, channel = {
  name: "main",
  enabled: true,
  transport_kind: "stdio",
  probe_status: "ok",
}, version = EXPECTED_TUNNEL_CLIENT_VERSION) {
  return JSON.stringify({
    entries: [{
      alias: "codex-chatgpt-web",
      live_runtime: {
        status: {
          version,
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

test("live inventory exposes the exact tunnel-client runtime version", () => {
  assert.deepEqual(
    liveTunnelVersionFromInventory(inventory("healthy", undefined, "0.0.12"), "codex-chatgpt-web"),
    { statusKnown: true, version: "0.0.12" },
  );
  assert.equal(
    liveTunnelVersionFromInventory(JSON.stringify({ entries: [] }), "codex-chatgpt-web").statusKnown,
    false,
  );
});

test("installed tunnel-client version is parsed from the binary version output", () => {
  assert.deepEqual(
    tunnelClientVersionFromOutput("tunnel-client version 0.0.12\n"),
    { statusKnown: true, version: "0.0.12" },
  );
  assert.equal(tunnelClientVersionFromOutput("unknown build").statusKnown, false);
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

test("monitor overrides green local probes when a stale tunnel-client process survived upgrade", async () => {
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
      return { code: 0, output: inventory("healthy", undefined, "0.0.12") };
    }
  }

  installTunnelResiliencePatch(FakeSupervisor);
  const result = await new FakeSupervisor().observeTunnelForMonitor({
    tunnel: { alias: "codex-chatgpt-web" },
  });

  assert.equal(result.ready, false);
  assert.equal(result.healthy, false);
  assert.equal(result.state, "degraded");
  assert.match(result.detail, /runtime_version=0\.0\.12 expected=0\.0\.13/);
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

test("start stops and upgrades an explicitly stale tunnel-client before adoption", async () => {
  class FakeSupervisor {
    constructor() {
      this.calls = [];
      this.tunnel = { pid: 1234 };
      this.logger = {
        warn: (...args) => this.calls.push(["warn", ...args]),
        info: (...args) => this.calls.push(["info", ...args]),
      };
    }

    async readLocalTunnelHealth() {
      return { ready: true, healthy: true, statusKnown: true, detail: "local ready" };
    }

    async observeTunnelForMonitor() {
      return { ready: true, healthy: true, statusKnown: true, detail: "local ready" };
    }

    async startTunnel() {
      this.calls.push("original-start");
    }

    async runTunnelCommand(_config, args) {
      if (args[0] === "--version") {
        this.calls.push("binary-version-probe");
        return { code: 0, output: "tunnel-client version 0.0.12" };
      }
      this.calls.push("version-probe");
      return { code: 0, output: inventory("healthy", undefined, "0.0.12") };
    }

    stopTunnelMonitor() {
      this.calls.push("stop-monitor");
    }

    async runTunnelStopCommand() {
      this.calls.push("stop-runtime");
      return { code: 0, output: "{}" };
    }

    async waitForTunnelStopped() {
      this.calls.push("wait-stopped");
    }

    async runTunnelClientUpgrade() {
      this.calls.push("upgrade-client");
      return { version: "0.0.13" };
    }
  }

  installTunnelResiliencePatch(FakeSupervisor);
  const supervisor = new FakeSupervisor();
  await supervisor.startTunnel({
    mode: "full",
    tunnel: { alias: "codex-chatgpt-web", binaryPath: "/tmp/tunnel-client" },
  });

  assert.equal(supervisor.tunnel, null);
  assert.ok(supervisor.calls.indexOf("stop-runtime") < supervisor.calls.indexOf("upgrade-client"));
  assert.ok(supervisor.calls.indexOf("upgrade-client") < supervisor.calls.indexOf("original-start"));
  assert.deepEqual(
    supervisor.calls.filter(call => typeof call === "string"),
    [
      "version-probe",
      "binary-version-probe",
      "stop-monitor",
      "stop-runtime",
      "wait-stopped",
      "upgrade-client",
      "original-start",
    ],
  );
});

test("start does not stop or upgrade a matching live tunnel-client", async () => {
  class FakeSupervisor {
    constructor() {
      this.calls = [];
      this.logger = { warn() {}, info() {} };
    }

    async readLocalTunnelHealth() {
      return { ready: true, healthy: true, statusKnown: true, detail: "local ready" };
    }

    async observeTunnelForMonitor() {
      return { ready: true, healthy: true, statusKnown: true, detail: "local ready" };
    }

    async startTunnel() {
      this.calls.push("original-start");
    }

    async runTunnelCommand(_config, args) {
      if (args[0] === "--version") {
        this.calls.push("binary-version-probe");
        return { code: 0, output: "tunnel-client version 0.0.13" };
      }
      this.calls.push("version-probe");
      return { code: 0, output: inventory("healthy") };
    }

    async runTunnelStopCommand() {
      this.calls.push("stop-runtime");
      return { code: 0, output: "{}" };
    }

    async runTunnelClientUpgrade() {
      this.calls.push("upgrade-client");
      return { version: "0.0.13" };
    }
  }

  installTunnelResiliencePatch(FakeSupervisor);
  const supervisor = new FakeSupervisor();
  await supervisor.startTunnel({
    mode: "full",
    tunnel: { alias: "codex-chatgpt-web", binaryPath: "/tmp/tunnel-client" },
  });

  assert.deepEqual(supervisor.calls, ["version-probe", "binary-version-probe", "original-start"]);
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
