import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bypass the HTTP_PROXY/HTTPS_PROXY env vars for localhost connections.
    // The proxy is set globally in this environment and would otherwise
    // intercept all fetch() calls — including those to 127.0.0.1 test servers.
    env: {
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
  },
});
