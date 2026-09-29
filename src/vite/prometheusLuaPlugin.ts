import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Plugin } from "vite"

export const PROMETHEUS_LUA_MODULE_ID = "virtual:prometheus-lua"

const resolvedModuleId = `\0${PROMETHEUS_LUA_MODULE_ID}`

export function luaPathToModuleName(filePath: string): string {
    const normalized = filePath.split(path.sep).join("/")
    const withoutSrc = normalized.replace(/^src\//, "")

    return withoutSrc
        .replace(/\.lua$/, "")
        .split("/")
        .join(".")
}

async function findLuaFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, {
        withFileTypes: true,
    })

    const files = await Promise.all(
        entries.map(async (entry) => {
            const absolute = path.join(
                directory,
                entry.name,
            )

            if (entry.isDirectory()) {
                return findLuaFiles(absolute)
            }

            if (
                entry.isFile() &&
                entry.name.endsWith(".lua")
            ) {
                return [absolute]
            }

            return []
        }),
    )

    return files.flat()
}

export function prometheusLuaPlugin(): Plugin {
    const repoRoot = path.resolve(
        fileURLToPath(
            new URL("../../..", import.meta.url),
        ),
    )

    const srcRoot = path.join(repoRoot, "src")

    return {
        name: "prometheus-lua",

        resolveId(id) {
            if (id === PROMETHEUS_LUA_MODULE_ID) {
                return resolvedModuleId
            }

            return null
        },

        async load(id) {
            if (id !== resolvedModuleId) {
                return null
            }

            const modules: Record<string, string> = {}

            const luaFiles = await findLuaFiles(srcRoot)

            for (const absolute of luaFiles) {
                const file = path.relative(
                    srcRoot,
                    absolute,
                )

                this.addWatchFile(absolute)

                const moduleName = luaPathToModuleName(
                    path.join("src", file),
                )

                modules[moduleName] = await readFile(
                    absolute,
                    "utf8",
                )
            }

            return `export default ${JSON.stringify(modules)};`
        },
    }
}
