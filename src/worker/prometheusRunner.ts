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
arg = {}

-- Compatibilidade com funções esperadas pelo Prometheus.
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
    if (!enginePromise) {
        enginePromise = createEngine()
    }

    return enginePromise
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

function getSafePreset(
    presetName: string,
): string {
    if (
        presetName === "Weak" ||
        presetName === "Medium" ||
        presetName === "Strong"
    ) {
        return presetName
    }

    return "Medium"
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

    const engine = await getEngine()

    const presetName = getSafePreset(preset)

    /*
     * Não usamos diretamente os presets oficiais.
     *
     * O suporte a Luau do Prometheus ainda possui
     * limitações. Por isso removemos transformações
     * que podem gerar código incompatível com Roblox.
     */

    const script = `
local Prometheus = require("prometheus")

local source = ${luaLongString(source)}

local presetName = ${JSON.stringify(presetName)}

local originalConfig = Prometheus.Presets[presetName]

if not originalConfig then
    error(
        "Preset inválido: "
        .. tostring(presetName)
    )
end

local config = {}

for key, value in pairs(originalConfig) do
    config[key] = value
end

config.LuaVersion = "LuaU"

local originalSteps = originalConfig.Steps or {}

local safeSteps = {}

for _, step in ipairs(originalSteps) do
    local name = step.Name

    /*
     * Essas etapas são deliberadamente ignoradas
     * porque são as mais problemáticas para manter
     * compatibilidade com Luau/Roblox.
     */

    if name ~= "Vmify"
        and name ~= "AntiTamper"
        and name ~= "NumbersToExpressions"
    then
        table.insert(
            safeSteps,
            step
        )
    end
end

config.Steps = safeSteps

local pipeline = Prometheus.Pipeline:fromConfig(
    config
)

local output = pipeline:apply(
    source,
    "input.lua"
)

if type(output) ~= "string" then
    error(
        "O Prometheus retornou um resultado inválido: "
        .. tostring(type(output))
    )
end

if output == "" then
    error(
        "O Prometheus retornou um código vazio."
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

        if (!result.trim()) {
            throw new Error(
                "O Prometheus retornou um código vazio.",
            )
        }

        return result
    } catch (error) {
        throw createPrometheusError(error)
    }
}
