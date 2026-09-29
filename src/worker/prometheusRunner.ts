import { LuaFactory } from "wasmoon"
import glueWasmUrl from "wasmoon/dist/glue.wasm?url"

import luaSources from "virtual:prometheus-lua"

type LuaEngine = Awaited<
    ReturnType<LuaFactory["createEngine"]>
>

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

-- Compatibilidade com ambientes que não possuem math.log10
if not math.log10 then
    math.log10 = function(value)
        return math.log(value) / math.log(10)
    end
end

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
    return createEngine()
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

    try {
        const script = `
local Prometheus = require("prometheus")

local source = ${luaLongString(code)}

local presetName = ${JSON.stringify(preset)}

local config = Prometheus.Presets[presetName]

if not config then
    config = Prometheus.Presets.Medium
end

-- Cria uma cópia limpa da configuração.
local cleanConfig = {}

for key, value in pairs(config) do
    cleanConfig[key] = value
end

cleanConfig.LuaVersion = "LuaU"

-- O Medium original possui algumas transformações
-- que podem quebrar scripts Roblox/LuaU.
-- Mantemos as transformações mais compatíveis
-- e removemos somente as problemáticas.
if presetName == "Medium" then
    local safeSteps = {}

    for _, step in ipairs(config.Steps or {}) do
        if step.Name ~= "AntiTamper"
            and step.Name ~= "NumbersToExpressions" then

            table.insert(safeSteps, step)
        end
    end

    cleanConfig.Steps = safeSteps
end

local pipeline = Prometheus.Pipeline:fromConfig(
    cleanConfig
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
    } finally {
        engine.global.close()
    }
}
