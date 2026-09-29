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

function patchPrometheusSource(
    name: string,
    source: string,
): string {
    if (name === "prometheus.enums") {
        return source.replace(
            `"::", "->", "?", "|", "&",`,
            `"::", "->", "?", "|", "&", "//",`,
        )
    }

    if (name === "prometheus.parser") {
        const oldBlock = `
		if(consume(self, TokenKind.Symbol, "%")) then
			local rhs = self:expressionUnary(scope);
			curr = Ast.ModExpression(curr, rhs, true);
			found = true;
		end
`

        const newBlock = `
		if(consume(self, TokenKind.Symbol, "%")) then
			local rhs = self:expressionUnary(scope);
			curr = Ast.ModExpression(curr, rhs, true);
			found = true;
		end

		if(consume(self, TokenKind.Symbol, "//")) then
			local rhs = self:expressionUnary(scope);

			local mathScope, mathId = scope:resolve("math");

			local mathExpression = Ast.VariableExpression(
				mathScope,
				mathId
			);

			local floorExpression = Ast.IndexExpression(
				mathExpression,
				Ast.StringExpression("floor")
			);

			local divisionExpression = Ast.DivExpression(
				curr,
				rhs,
				true
			);

			curr = Ast.FunctionCallExpression(
				floorExpression,
				{
					divisionExpression
				}
			);

			found = true;
		end
`

        if (!source.includes(oldBlock)) {
            throw new Error(
                "Não foi possível aplicar a correção do operador // no parser do Prometheus.",
            )
        }

        return source.replace(
            oldBlock,
            newBlock,
        )
    }

    return source
}

function createBootstrap(): string {
    const modules = Object.entries(luaSources)
        .map(([name, originalSource]) => {
            const source = patchPrometheusSource(
                name,
                originalSource,
            )

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
    return new Error(
        getErrorMessage(error),
    )
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

const SAFE_STEPS: Record<string, string[]> = {
    Weak: [
        "Vmify",
        "ConstantArray",
        "WrapInFunction",
    ],

    Medium: [
        "Vmify",
        "ConstantArray",
        "WrapInFunction",
    ],

    Strong: [
        "Vmify",
        "ConstantArray",
        "Vmify",
        "WrapInFunction",
    ],
}

function createSafeConfig(
    Prometheus: any,
    presetName: string,
) {
    const originalConfig =
        Prometheus.Presets[presetName]

    if (!originalConfig) {
        error(
            "Preset inválido: "
            .. tostring(presetName)
        )
    }

    local config = {}

    for key, value in pairs(originalConfig) do
        config[key] = value
    end

    config.LuaVersion = "LuaU"

    local allowedSteps =
        SAFE_STEPS[presetName]

    local selectedSteps = {}

    for _, wantedName in ipairs(allowedSteps) do
        for _, step in ipairs(originalConfig.Steps or {}) do
            if step.Name == wantedName then
                table.insert(
                    selectedSteps,
                    step
                )

                break
            end
        end
    end

    config.Steps = selectedSteps

    return config
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

    const safeSteps =
        SAFE_STEPS[presetName]

    if (!safeSteps) {
        throw new Error(
            "Preset inválido.",
        )
    }

    const script = `
local Prometheus = require("prometheus")

local source = ${luaLongString(source)}

local presetName = ${JSON.stringify(presetName)}

local originalConfig =
    Prometheus.Presets[presetName]

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

local wantedSteps = ${JSON.stringify(safeSteps)}

local safeSteps = {}

for _, wantedName in ipairs(wantedSteps) do
    for _, step in ipairs(
        originalConfig.Steps or {}
    ) do
        if step.Name == wantedName then
            table.insert(
                safeSteps,
                step
            )

            break
        end
    end
end

config.Steps = safeSteps

local pipeline =
    Prometheus.Pipeline:fromConfig(
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
