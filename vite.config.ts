import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Machine-specific dev hostnames live in the gitignored `.env.local`
  // (QATTARA_DEV_HOSTS, comma-separated) so the tailnet name stays out of
  // this public repo.
  const env = loadEnv(mode, process.cwd(), 'QATTARA_');
  const devHosts = (env.QATTARA_DEV_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  return {
    server: {
      // Vite blocks unrecognized Host headers by default. LAN IP access is
      // exempt automatically; the Tailscale Serve hostname (a real hostname
      // proxying in) is not, so it has to be listed here.
      allowedHosts: devHosts,
    },
  };
});
