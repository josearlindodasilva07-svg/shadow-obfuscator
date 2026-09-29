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
-- Ambiente compatível com o CLI do Prometheus
arg = {}

${modules}

return true
`
}

async function createEngine(): Promise<LuaEngine> {
    const factory = new LuaFactory(glueWasmUrl)

    const engine = await factory.createEngine()

    await engine.doString(
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

local presetName = ${JSON.stringify(preset)}

local config = Prometheus.Presets[presetName]

if not config then
    config = Prometheus.Presets.Medium
end

config.LuaVersion = "LuaU"

local pipeline = Prometheus.Pipeline:fromConfig(
    config
)

local output = pipeline:apply(
    source,
    "input.lua"
)

return output
`

    const result = await engine.doString(script)

    if (typeof result !== "string") {
        throw new Error(
            `O Prometheus retornou um valor inválido: ${typeof result}`,
        )
    }

    return result
}
