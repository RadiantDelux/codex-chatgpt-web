import { installTunnelClient, TUNNEL_VERSION } from "./tunnel";

try {
  const executable = await installTunnelClient();
  process.stdout.write(`${JSON.stringify({ version: TUNNEL_VERSION, executable })}\n`);
} catch (error) {
  process.stderr.write(`tunnel-client upgrade failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
