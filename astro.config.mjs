// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
	site: "https://workbench-web.nmulvaine.workers.dev",
	output: "server",
	session: false,
	adapter: cloudflare({ imageService: "compile" }),
});
