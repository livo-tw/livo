import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

// GA + canonical belong ONLY to our hosted cloud/demo build. Customer
// self-host builds (--mode customer/localdb) and dev must ship no third-party
// analytics and no livo-tw.com references (audited: GA in a customer install
// leaks their internal usage to our GA property).
function cloudHeadPlugin(mode: string): Plugin {
  return {
    name: "livo-cloud-head",
    transformIndexHtml(html) {
      if (mode !== "production") return html;
      return html.replace(
        "</title>",
        `</title>
    <link rel="canonical" href="https://livo-tw.com/demo/" />
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-VFPTBRYKMW"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-VFPTBRYKMW');
    </script>`
      );
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: "/demo/",
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    cloudHeadPlugin(mode),
    VitePWA({
      // selfDestroying: the old precache-navigation service worker served
      // cache-first /demo/index.html referencing hashed chunks that each
      // Cloudflare Pages deploy deletes → returning browsers hit ERR_FAILED
      // (notably on ?plan=pro / ?demo=pro). This app is an auth-gated
      // collaborative tool that is never used offline, so the SW only ever
      // produced stale-deploy breakage. A self-destroying SW unregisters
      // itself and clears all caches on every client (browsers always
      // revalidate sw.js from network), permanently killing this bug class.
      selfDestroying: true,
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "pwa-icon-192.png", "pwa-icon-512.png"],
      workbox: {
        navigateFallback: "/demo/index.html",
        navigateFallbackAllowlist: [/^\/demo\//],
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
      },
      manifest: {
        name: "LIVO - 專案管理",
        short_name: "LIVO",
        description: "LIVO 專案管理工具",
        theme_color: "#1a1a2e",
        background_color: "#1a1a2e",
        display: "standalone",
        orientation: "any",
        start_url: "/demo/",
        scope: "/demo/",
        icons: [
          {
            src: "/demo/pwa-icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/demo/pwa-icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/demo/pwa-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ].filter(Boolean),
  build: {
    rollupOptions: {
      output: {
        // Split heavy, independently-cacheable vendor libs out of the main
        // app chunk so a code change doesn't bust their cache and the initial
        // parse is smaller. Each group is only pulled in by the routes/views
        // that use it.
        manualChunks: {
          'supabase': ['@supabase/supabase-js'],
          'editor': [
            '@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-color',
            '@tiptap/extension-image', '@tiptap/extension-mention',
            '@tiptap/extension-placeholder', '@tiptap/extension-table',
            '@tiptap/extension-text-style', '@tiptap/extension-underline',
            'dompurify',
          ],
          'charts': ['recharts'],
          'dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          'datefns': ['date-fns'],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})); 