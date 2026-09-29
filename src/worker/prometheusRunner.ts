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
arg = {}

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

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }

    return String(error)
}

function formatPrometheusError(error: unknown): Error {
    const message = getErrorMessage(error)

    if (
        message.includes("Parsing Error") ||
        message.includes("Unexpected Token")
    ) {
        return new Error(
            "O Prometheus não conseguiu interpretar alguma parte do código Luau. " +
            "Isso pode acontecer com determinadas construções de Luau ou código " +
            "gerado por outro obfuscador.\n\n" +
            message,
        )
    }

    return new Error(message)
}

export async function obfuscateLua(
    code: string,
    preset = "Medium",
): Promise<string> {
    const source = code.trim()

    if (!source) {
        throw new Error(
            "Nenhum código Luau foi fornecido.",
        )
    }

    const engine = await createEngine()

    try {
        const script = `
local Prometheus = require("prometheus")

local source = ${luaLongString(source)}

local presetName = ${JSON.stringify(preset)}

local config = Prometheus.Presets[presetName]

if not config then
    error("Preset inválido: " .. tostring(presetName))
end

local cleanConfig = {}

for key, value in pairs(config) do
    cleanConfig[key] = value
end

cleanConfig.LuaVersion = "LuaU"

if presetName == "Medium" then
    local safeSteps = {}

    for _, step in ipairs(cleanConfig.Steps or {}) do
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

if type(output) ~= "string" then
    error(
        "O Prometheus retornou um resultado inválido: "
        .. type(output)
    )
end

return output
`

        try {
            const result = await engine.doString(script)

            if (typeof result !== "string") {
                throw new Error(
                    `O Prometheus retornou um valor inválido: ${typeof result}`,
                )
            }

            return result
        } catch (error) {
            throw formatPrometheusError(error)
        }
    } finally {
        engine.global.close()
    }
}
