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

-- Compatibilidade com math.log10.
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

function createPrometheusError(error: unknown): Error {
    const message = getErrorMessage(error)

    return new Error(message)
}

function createSafeConfig(
    config: Record<string, any>,
    presetName: string,
): Record<string, any> {
    const cleanConfig: Record<string, any> = {}

    for (const key of Object.keys(config)) {
        cleanConfig[key] = config[key]
    }

    cleanConfig.LuaVersion = "LuaU"

    const originalSteps = Array.isArray(config.Steps)
        ? config.Steps
        : []

    const safeSteps = []

    for (const step of originalSteps) {
        if (!step || typeof step.Name !== "string") {
            continue
        }

        const name = step.Name

        /*
         * Essas duas transformações já demonstraram
         * problemas com scripts Roblox/Luau:
         *
         * AntiTamper
         * NumbersToExpressions
         *
         * O Weak não passa por este filtro.
         */
        if (
            (presetName === "Medium" || presetName === "Strong") &&
            (
                name === "AntiTamper" ||
                name === "NumbersToExpressions"
            )
        ) {
            continue
        }

        safeSteps.push(step)
    }

    cleanConfig.Steps = safeSteps

    return cleanConfig
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
    error(
        "Preset inválido: "
        .. tostring(presetName)
    )
end

local cleanConfig = {}

for key, value in pairs(config) do
    cleanConfig[key] = value
end

cleanConfig.LuaVersion = "LuaU"

local originalSteps = config.Steps or {}
local safeSteps = {}

for _, step in ipairs(originalSteps) do
    local name = step.Name

    if not (
        (
            presetName == "Medium"
            or presetName == "Strong"
        )
        and (
            name == "AntiTamper"
            or name == "NumbersToExpressions"
        )
    ) then
        table.insert(
            safeSteps,
            step
        )
    end
end

cleanConfig.Steps = safeSteps

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
            const result = await engine.doString(
                script,
            )

            if (typeof result !== "string") {
                throw new Error(
                    `O Prometheus retornou um valor inválido: ${typeof result}`,
                )
            }

            return result
        } catch (error) {
            throw createPrometheusError(error)
        }
    } finally {
        engine.global.close()
    }
}
