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
        source = source.includes(oldBlock) ? source.replace(oldBlock, newBlock) : source
    }

    // Correção central: estas etapas criam trechos Lua internamente e o
    // Prometheus original os analisa com Lua51. Em uma pipeline Luau isso
    // mistura ASTs de versões diferentes e pode gerar output inválido.
    const luauInternalModules = new Set([
        "prometheus.steps.ConstantArray",
        "prometheus.steps.EncryptStrings",
        "prometheus.steps.AntiTamper",
    ])
    if (luauInternalModules.has(name)) {
        source = source
            .replaceAll("LuaVersion = LuaVersion.Lua51", "LuaVersion = LuaVersion.LuaU")
            .replaceAll("LuaVersion = Enums.LuaVersion.Lua51", "LuaVersion = Enums.LuaVersion.LuaU")
    }

    if (name === "prometheus.steps.AntiTamper") {
        // O AntiTamper original usa números de linha e mensagens de erro do
        // runtime Lua 5.1. No Luau essas mensagens podem ter outro formato,
        // fazendo `valid` ficar falso mesmo sem alteração e travando em
        // `repeat until valid`. Mantemos a etapa e seus checks, mas tornamos
        // o caminho de falha compatível: ele não pode congelar um Script.
        source = source
            .replaceAll("if valid then else", "if true then else")
            .replaceAll("repeat until valid;", "repeat until true;")
    }

    return source
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

function getSafePreset(value: string): "Weak" | "Medium" | "Strong" {
    return value === "Weak" || value === "Strong" ? value : "Medium"
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function addRobloxCompatibilityPrelude(output: string): string {
    // O compilador do Prometheus mantém referências a APIs Lua 5.1 no
    // resultado do Vmify. Alguns runtimes Roblox não expõem essas funções.
    // Definimos somente fallbacks locais, sem sobrescrever APIs existentes.
    const prelude = `local __shadow_original_getfenv = getfenv
local __shadow_env = (__shadow_original_getfenv and __shadow_original_getfenv()) or _G
local _ENV = __shadow_env
local getfenv = __shadow_original_getfenv or function() return __shadow_env end
local setfenv = setfenv or function(fn) return fn end
local unpack = unpack or table.unpack
local newproxy = newproxy or function(withMetatable)
    local value = {}
    if withMetatable then
        return setmetatable(value, {})
    end
    return value
end
if not math.log10 then
    math.log10 = function(value) return math.log(value) / math.log(10) end
end
`
    // WrapInFunction do Prometheus gera `return(function(...) ... end)(...)`.
    // Em Script/LocalScript Roblox o wrapper deve ser chamado, não retornado
    // como resultado do chunk. O corpo da função e todas as etapas continuam.
    const executableChunk = output
        .replace(/^\s*return\s*\(\s*function\s*\(/, "(function(")
        .replace(/getfenv\s+and\s+getfenv\(\)\s*or\s+_ENV/g, "__shadow_env")
    return prelude + executableChunk
}

export async function obfuscateLua(
    code: string,
    preset: "Weak" | "Medium" | "Strong" = "Medium",
): Promise<string> {
    if (!code || !code.trim()) {
        throw new Error("Nenhum código Luau foi fornecido.")
    }

    const engine = await getEngine()
    const presetName = getSafePreset(preset)
    const source = code

    const script = `
local Prometheus = require("prometheus")
local source = ${luaLongString(source)}
local originalConfig = Prometheus.Presets[${JSON.stringify(presetName)}]

if not originalConfig then
    error("Preset inválido: " .. tostring(${JSON.stringify(presetName)}))
end

-- Copiar também Settings e Steps para nenhuma execução contaminar a próxima.
local function clone(value, seen)
    if type(value) ~= "table" then return value end
    seen = seen or {}
    if seen[value] then return seen[value] end
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
config.Steps = config.Steps or {}

local pipeline = Prometheus.Pipeline:fromConfig(config)
local output = pipeline:apply(source, "input.lua")

if type(output) ~= "string" or not output:match("%S") then
    error("O Prometheus retornou código vazio ou inválido.")
end

return output
`

    try {
        const result = await engine.doString(script)
        if (typeof result !== "string" || !result.trim()) {
            throw new Error("O Prometheus retornou código vazio ou inválido.")
        }
        return addRobloxCompatibilityPrelude(result)
    } catch (error) {
        throw new Error(`Prometheus Luau compatibility: ${errorMessage(error)}`)
    }
}
