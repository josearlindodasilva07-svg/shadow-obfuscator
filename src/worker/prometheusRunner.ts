import { LuaFactory } from "wasmoon"
import glueWasmUrl from "wasmoon/dist/glue.wasm?url"

import luaSources from "virtual:prometheus-lua"

type LuaEngine = Awaited<
    ReturnType<LuaFactory["createEngine"]>
>

let enginePromise: Promise<LuaEngine> | null = null

function luaLongString(value: string): string {
    let maxEquals = 0

    for (const match of value.matchAll(/\](=*)\]/g)) {
        maxEquals = Math.max(
            maxEquals,
            match[1].length + 1,
        )
    }

    const equals = "=".repeat(maxEquals)

    return `[${equals}[${value}]${equals}]`
}

function createBootstrap(): string {
    const modules = Object.entries(luaSources)
        .map(([name, source]) => {
            return `
package.preload[${JSON.stringify(name)}] = function(...)
${source}
end
`
        })
        .join("\n")

    return `
${modules}

return true
`
}

async function createEngine(): Promise<LuaEngine> {
    const factory = new LuaFactory(glueWasmUrl)

    const engine = await factory.createEngine()

    await engine.doStringAsync(
        createBootstrap(),
    )

    return engine
}

async function getEngine(): Promise<LuaEngine> {
    if (!enginePromise) {
        enginePromise = createEngine()
    }

    return enginePromise
}

export async function obfuscateLua(
    code: string,
    preset = "Medium",
): Promise<string> {
    if (!code.trim()) {
        throw new Error(
            "Nenhum código Luau foi fornecido.",
        )
    }

    const engine = await getEngine()

    const script = `
local Prometheus = require("prometheus")

local source = ${luaLongString(code)}

local config

if ${JSON.stringify(preset)} == "Weak" then
    config = Prometheus.Presets.Weak
elseif ${JSON.stringify(preset)} == "Strong" then
    config = Prometheus.Presets.Strong
else
    config = Prometheus.Presets.Medium
end

local result = Prometheus:obfuscate(
    source,
    config
)

return result
`

    const result = await engine.doStringAsync(script)

    if (typeof result ~= "string") {
        throw new Error(
            "O Prometheus não retornou um código válido.",
        )
    }

    return result
}
