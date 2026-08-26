const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { installTunnelResiliencePatch } = require("./runtime-supervisor-tunnel-resilience.cjs");

installTunnelResiliencePatch(RuntimeSupervisor);
require("./main.cjs");
