import { LuaFactory } from "wasmoon"
import glueWasmUrl from "wasmoon/dist/glue.wasm?url"
import luaSources from "virtual:prometheus-lua"

type LuaEngine = Awaited<ReturnType<LuaFactory["createEngine"]>>
let enginePromise: Promise<LuaEngine> | null = null

function luaLongString(value: string): string {
    let maxEquals = 0
    for (const match of value.matchAll(/\](=*)\]/g)) {
        maxEquals = Math.max(maxEquals, match[1].length + 1)
    }
    const equals = "=".repeat(maxEquals)
    return `[${equals}[${value}]${equals}]`
}

function patchPrometheusSource(name: string, source: string): string {
    if (name === "prometheus.enums") {
        return source.replace(
            `"::", "->", "?", "|", "&",`,
            `"::", "->", "?", "|", "&", "//",`,
        )
    }

    if (name !== "prometheus.parser") return source

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
    return source.includes(oldBlock) ? source.replace(oldBlock, newBlock) : source
}

function createBootstrap(): string {
    const modules = Object.entries(luaSources).map(([name, originalSource]) => {
        const source = patchPrometheusSource(name, originalSource)
        return `package.preload[${JSON.stringify(name)}] = function(...)
${source}
end`
    }).join("\n")

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

async function getEngine(): Promise<LuaEngine> {
    if (!enginePromise) {
        enginePromise = (async () => {
            const factory = new LuaFactory(glueWasmUrl)
            const engine = await factory.createEngine()
            await engine.doString(createBootstrap())
            return engine
        })()
    }
    return enginePromise
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function safePresetSteps(preset: "Weak" | "Medium" | "Strong"): string {
    // Roblox-safe: não usa Vmify, AntiTamper, NumbersToExpressions ou
    // WrapInFunction, pois essas etapas podem alterar o ambiente de execução.
    if (preset === "Weak") {
        return `{
            { Name = "ConstantArray", Settings = {
                Threshold = 1,
                StringsOnly = true,
                Shuffle = true,
                Rotate = true,
                LocalWrapperThreshold = 0,
                Encoding = "mixed"
            }}
        }`
    }

    return `{
        { Name = "EncryptStrings", Settings = {} },
        { Name = "SplitStrings", Settings = {
            Threshold = 0.85,
            MinLength = 3,
            MaxLength = 8,
            ConcatenationType = "custom",
            CustomFunctionType = "inline"
        } },
        { Name = "ConstantArray", Settings = {
            Threshold = 1,
            StringsOnly = true,
            Shuffle = true,
            Rotate = ${preset === "Strong" ? "true" : "false"},
            LocalWrapperThreshold = 0,
            Encoding = "mixed"
        }}
    }`
}

function getSafePreset(value: string): "Weak" | "Medium" | "Strong" {
    return value === "Weak" || value === "Strong" ? value : "Medium"
}

export async function obfuscateLua(
    code: string,
    preset: "Weak" | "Medium" | "Strong" = "Medium",
): Promise<string> {
    if (!code || !code.trim()) {
        throw new Error("Nenhum código Luau foi fornecido.")
    }

    const engine = await getEngine()
    const selectedPreset = getSafePreset(preset)
    const source = code
    const steps = safePresetSteps(selectedPreset)

    const script = `
local Prometheus = require("prometheus")
local source = ${luaLongString(source)}
local originalConfig = Prometheus.Presets.Minify

if not originalConfig then
    error("Preset Minify não encontrado no Prometheus.")
end

local config = {}
for key, value in pairs(originalConfig) do
    config[key] = value
end

config.LuaVersion = "LuaU"
config.PrettyPrint = false
config.VarNamePrefix = ""
config.NameGenerator = "MangledShuffled"
config.Seed = 0
config.Steps = ${steps}

local pipeline = Prometheus.Pipeline:fromConfig(config)
local output = pipeline:apply(source, "input.lua")

if type(output) ~= "string" or output == "" then
    error("O Prometheus não retornou código Luau válido.")
end

return output
`

    try {
        const result = await engine.doString(script)
        if (typeof result !== "string" || !result.trim()) {
            throw new Error("O Prometheus retornou um resultado vazio.")
        }
        return result
    } catch (error) {
        throw new Error(`Prometheus Roblox-safe: ${getErrorMessage(error)}`)
    }
}
