import { LuaFactory } from "wasmoon"
import glueWasmUrl from "wasmoon/dist/glue.wasm?url"

import luaSources from "virtual:prometheus-lua"

type LuaEngine = Awaited<ReturnType<LuaFactory["createEngine"]>>

let enginePromise: Promise<LuaEngine> | null = null

/**
 * Prometheus suporta Luau, mas o próprio projeto informa que esse suporte ainda
 * não está totalmente concluído. Por isso o wrapper mantém LuaVersion = LuaU
 * e evita mutar o preset original entre chamadas.
 */
function luaLongString(value: string): string {
    let equalsCount = 0

    for (const match of value.matchAll(/\](=*)\]/g)) {
        equalsCount = Math.max(equalsCount, match[1].length + 1)
    }

    const equals = "=".repeat(equalsCount)
    return `[${equals}[${value}]${equals}]`
}

function patchPrometheusSource(name: string, source: string): string {
    // O parser distribuído em algumas versões do Prometheus não conhece //.
    // Esta alteração somente adiciona o operador ao parser; ela não altera o
    // código do usuário nem transforma divisão comum em divisão inteira.
    if (name === "prometheus.enums") {
        return source.replace(
            `"::", "->", "?", "|", "&",`,
            `"::", "->", "?", "|", "&", "//",`,
        )
    }

    if (name === "prometheus.parser") {
        const oldBlock = `
\t\t\tif(consume(self, TokenKind.Symbol, "%")) then
\t\t\t\tlocal rhs = self:expressionUnary(scope);
\t\t\t\tcurr = Ast.ModExpression(curr, rhs, true);
\t\t\t\tfound = true;
\t\t\tend
`

        const newBlock = `
\t\t\tif(consume(self, TokenKind.Symbol, "%")) then
\t\t\t\tlocal rhs = self:expressionUnary(scope);
\t\t\t\tcurr = Ast.ModExpression(curr, rhs, true);
\t\t\t\tfound = true;
\t\t\tend

\t\t\tif(consume(self, TokenKind.Symbol, "//")) then
\t\t\t\tlocal rhs = self:expressionUnary(scope);
\t\t\t\tlocal mathScope, mathId = scope:resolve("math");
\t\t\t\tlocal mathExpression = Ast.VariableExpression(mathScope, mathId);
\t\t\t\tlocal floorExpression = Ast.IndexExpression(mathExpression, Ast.StringExpression("floor"));
\t\t\t\tlocal divisionExpression = Ast.DivExpression(curr, rhs, true);
\t\t\t\tcurr = Ast.FunctionCallExpression(floorExpression, { divisionExpression });
\t\t\t\tfound = true;
\t\t\tend
`

        // Não interromper o carregamento se a versão instalada já tiver //.
        return source.includes(oldBlock) ? source.replace(oldBlock, newBlock) : source
    }

    return source
}

function createBootstrap(): string {
    const modules = Object.entries(luaSources)
        .map(([name, originalSource]) => {
            const source = patchPrometheusSource(name, originalSource)
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
    await engine.doString(createBootstrap())
    return engine
}

async function getEngine(): Promise<LuaEngine> {
    if (!enginePromise) enginePromise = createEngine()
    return enginePromise
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function createPrometheusError(error: unknown): Error {
    return new Error(`Prometheus/Luau: ${getErrorMessage(error)}`)
}

function getSafePreset(presetName: string): "Weak" | "Medium" | "Strong" {
    if (presetName === "Weak" || presetName === "Medium" || presetName === "Strong") {
        return presetName
    }
    return "Medium"
}

export async function obfuscateLua(
    code: string,
    preset: "Weak" | "Medium" | "Strong" = "Medium",
): Promise<string> {
    // Não remova espaços do começo/fim do código: eles podem fazer parte de
    // comentários longos ou de uma entrada que o usuário quer preservar.
    if (!code || !code.trim()) {
        throw new Error("Nenhum código Luau foi fornecido.")
    }

    const engine = await getEngine()
    const presetName = getSafePreset(preset)
    const source = code

    const script = `
local Prometheus = require("prometheus")
local source = ${luaLongString(source)}
local presetName = ${JSON.stringify(presetName)}
local originalConfig = Prometheus.Presets[presetName]

if not originalConfig then
    error("Preset inválido: " .. tostring(presetName))
end

-- Cópia profunda: alguns steps alteram Settings durante o pipeline.
-- Sem isso, uma segunda execução pode herdar estado da primeira.
local function clone(value, seen)
    if type(value) ~= "table" then
        return value
    end
    seen = seen or {}
    if seen[value] then
        return seen[value]
    end
    local result = {}
    seen[value] = result
    for key, item in pairs(value) do
        result[clone(key, seen)] = clone(item, seen)
    end
    return result
end

local config = clone(originalConfig)
config.LuaVersion = "LuaU"
config.PrettyPrint = false

local pipeline = Prometheus.Pipeline:fromConfig(config)
local output = pipeline:apply(source, "input.lua")

if type(output) ~= "string" or output == "" then
    error("O Prometheus retornou um código inválido.")
end

return output
`

    try {
        const result = await engine.doString(script)
        if (typeof result !== "string" || !result.trim()) {
            throw new Error("O Prometheus retornou um código vazio ou inválido.")
        }
        return result
    } catch (error) {
        throw createPrometheusError(error)
    }
}
