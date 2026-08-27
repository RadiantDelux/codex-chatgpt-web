// tunnel-client v0.0.13 can complete the MCP lifecycle for callers that omit
// notifications/initialized. Force that compatibility mode for the launcher-owned runtime so the
// stdio server cannot remain half-initialized behind an otherwise healthy tunnel.
process.env.MCP_STDIO_SEND_INITIALIZED_NOTIFICATION = "true";
process.env.MCP_CONNECTION_MAX_TTL = "24h";

const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { installTunnelResiliencePatch } = require("./runtime-supervisor-tunnel-resilience.cjs");

installTunnelResiliencePatch(RuntimeSupervisor);
require("./main.cjs");
