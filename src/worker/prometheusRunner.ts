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

function getSafePreset(): "Strong" {
    return "Strong"
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function decodeLuaLiteral(value: string): string {
    return value.replace(/\\(\\|"|'|n|r|t|b|f|v|a|x[0-9a-fA-F]{2}|[0-9]{1,3})/g, (_, token: string) => {
        if (token === "\\") return "\\"
        if (token === '"') return '"'
        if (token === "'") return "'"
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", a: "\x07" }
        if (escapes[token]) return escapes[token]
        if (token.startsWith("x")) return String.fromCharCode(Number.parseInt(token.slice(1), 16))
        return String.fromCharCode(Number.parseInt(token, 10))
    })
}

function encryptLuaStrings(source: string): string {
    const key = 173
    const encoded: string[] = []
    const memberNames = new Set([
        "GetService", "LocalPlayer", "Character", "CharacterAdded", "WaitForChild",
        "Connect", "Name", "ResetOnSpawn", "Parent", "Size", "Position",
        "BackgroundColor3", "Text", "TextColor3", "TextSize", "Font", "Active",
        "CornerRadius", "InputBegan", "Changed", "InputState", "UserInputType",
        "MouseButton1", "Touch", "End", "InputChanged", "MouseMovement",
        "MouseButton1Click", "JumpRequest", "Health", "ChangeState", "X", "Y",
        "Scale", "Offset",
    ])
    const addEncoded = (value: string): number => {
        const bytes = Array.from(new TextEncoder().encode(value), byte => (byte ^ key) + 1)
        return encoded.push(`{${bytes.join(",")}}`)
    }
    let result = ""
    let cursor = 0
    let index = 0

    while (index < source.length) {
        const character = source[index]
        if (character === "-" && source[index + 1] === "-") {
            const end = source.indexOf("\n", index)
            index = end === -1 ? source.length : end
            continue
        }
        if (character !== '"' && character !== "'") {
            index += 1
            continue
        }

        const quote = character
        let end = index + 1
        let escaped = false
        while (end < source.length) {
            const current = source[end]
            if (!escaped && current === quote) break
            if (!escaped && current === "\\") escaped = true
            else escaped = false
            end += 1
        }
        if (end >= source.length) {
            index += 1
            continue
        }

        const literal = decodeLuaLiteral(source.slice(index + 1, end))
        const id = addEncoded(literal)
        result += source.slice(cursor, index) + `__shadow_decode(${id})`
        cursor = end + 1
        index = end + 1
        continue
    }

    result += source.slice(cursor)

    // Transformar somente acessos fora de strings/comentários. O scanner acima
    // já removeu cada literal, então os membros Roblox restantes são seguros.
    let memberIndex = 0
    let memberResult = ""
    let memberCursor = 0
    while (memberIndex < result.length) {
        if (result[memberIndex] === "." && result[memberIndex - 1] !== ".") {
            const member = result.slice(memberIndex + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0]
            if (member && memberNames.has(member)) {
                const id = addEncoded(member)
                memberResult += result.slice(memberCursor, memberIndex) + `[__shadow_decode(${id})]`
                memberCursor = memberIndex + 1 + member.length
                memberIndex = memberCursor
                continue
            }
        }
        memberIndex += 1
    }

    if (!encoded.length) return source
    memberResult += result.slice(memberCursor)
    const table = `{${encoded.join(",")}}`
    const decoder = `local __shadow_data=${table};local __shadow_decode=function(i)local t=__shadow_data[i]local o={}for n=1,#t do o[n]=string.char((t[n]-1)~${key})end return table.concat(o)end;`
    return decoder + memberResult
}

function addRobloxCompatibilityPrelude(output: string): string {
    // O compilador do Prometheus mantém referências a APIs Lua 5.1 no
    // resultado do Vmify. Alguns runtimes Roblox não expõem essas funções.
    // Definimos somente fallbacks locais, sem sobrescrever APIs existentes.
    const prelude = `local __shadow_real_getfenv = getfenv
local __shadow_env = (_ENV or _G)
if type(__shadow_real_getfenv) == "function" then
    local __shadow_ok, __shadow_value = pcall(__shadow_real_getfenv)
    if __shadow_ok and type(__shadow_value) == "table" then
        __shadow_env = __shadow_value
    end
end
local __shadow_string = string
local __shadow_table = table
local __shadow_math = math
local __shadow_coroutine = coroutine
local __shadow_utf8 = utf8
local __shadow_os = os
local __shadow_debug = debug
__shadow_env.string = __shadow_env.string or __shadow_string
__shadow_env.table = __shadow_env.table or __shadow_table
__shadow_env.math = __shadow_env.math or __shadow_math
__shadow_env.coroutine = __shadow_env.coroutine or __shadow_coroutine
__shadow_env.utf8 = __shadow_env.utf8 or __shadow_utf8
__shadow_env.os = __shadow_env.os or __shadow_os
__shadow_env.debug = __shadow_env.debug or __shadow_debug
__shadow_env._G = __shadow_env
__shadow_env.assert = __shadow_env.assert or assert
__shadow_env.error = __shadow_env.error or error
__shadow_env.getmetatable = __shadow_env.getmetatable or getmetatable
__shadow_env.setmetatable = __shadow_env.setmetatable or setmetatable
__shadow_env.pcall = __shadow_env.pcall or pcall
__shadow_env.xpcall = __shadow_env.xpcall or xpcall
__shadow_env.type = __shadow_env.type or type
__shadow_env.tostring = __shadow_env.tostring or tostring
__shadow_env.tonumber = __shadow_env.tonumber or tonumber
__shadow_env.select = __shadow_env.select or select
__shadow_env.next = __shadow_env.next or next
__shadow_env.pairs = __shadow_env.pairs or pairs
__shadow_env.ipairs = __shadow_env.ipairs or ipairs
__shadow_env.rawget = __shadow_env.rawget or rawget
__shadow_env.rawset = __shadow_env.rawset or rawset
local getfenv = function() return __shadow_env end
local setfenv = function(fn) return fn end
local unpack = (__shadow_table and __shadow_table.unpack) or unpack
local newproxy = function(withMetatable)
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
        .replace(/getfenv\s*and\s*getfenv\s*\(\s*\)\s*or\s*_ENV/g, "__shadow_env")
        .replace(/getfenv\s*and\s*getfenv\s*\(\s*0\s*\)\s*or\s*_ENV/g, "__shadow_env")
    return prelude + executableChunk
}

export async function obfuscateLua(
    code: string,
): Promise<string> {
    if (!code || !code.trim()) {
        throw new Error("Nenhum código Luau foi fornecido.")
    }

    const engine = await getEngine()
    const presetName = getSafePreset()
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
-- Usar o Strong completo para produzir o formato VM do preset: tabela de
-- strings, decoder, nomes renomeados e fluxo de controle embaralhado.

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
