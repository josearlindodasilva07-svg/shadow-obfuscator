import { defineConfig } from "vite"
import { prometheusLuaPlugin } from "./src/vite/prometheusLuaPlugin"

export default defineConfig({
    plugins: [
        prometheusLuaPlugin(),
    ],
    build: {
        target: "es2020",
    },
})
