import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Vite 默认绑 localhost → Windows 上往往只有 [::1]，127.0.0.1 会打不开。
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure(proxy) {
          proxy.on("proxyRes", (proxyRes, req) => {
            if (req.url?.includes("/events/stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
});
