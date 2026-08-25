import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Vite blocks unrecognized Host headers by default. LAN IP access is
    // exempt automatically; the Tailscale Serve hostname is not, since it's
    // a real hostname proxying in from https://<tailnet-host>.
    allowedHosts: ['<tailnet-host>'],
  },
});
