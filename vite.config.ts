import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // הגדרות עבור הפרירנדר (SSG)
  ssgOptions: {
    script: 'async', // טעינת סקריפטים בצורה אסינכרונית לביצועים טובים יותר
    formatting: 'minify', // כיווץ ה-HTML שנוצר
    includedRoutes() {
      // כאן אנחנו מגדירים אילו נתיבים לרנדר. כרגע רק את דף הבית.
      return ['/'];
    },
  },
}));
