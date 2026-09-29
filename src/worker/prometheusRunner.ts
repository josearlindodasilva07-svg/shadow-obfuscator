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

/*
 * Converte o operador Luau // para uma expressão
 * compatível com o parser do Prometheus.
 *
 * Exemplo:
 *
 *     a // b
 *
 * vira:
 *
 *     math.floor(a / b)
 *
 * Strings, comentários e long strings não são alterados.
 */

function convertFloorDivision(source: string): string {
    const chars = [...source]
    const output: string[] = []

    let i = 0

    function isIdentifierStart(
        char: string | undefined,
    ): boolean {
        return !!char && /[A-Za-z_]/.test(char)
    }

    function isIdentifierPart(
        char: string | undefined,
    ): boolean {
        return !!char && /[A-Za-z0-9_]/.test(char)
    }

    function skipWhitespaceForward(
        position: number,
    ): number {
        while (
            position < chars.length
            && /\s/.test(chars[position])
        ) {
            position++
        }

        return position
    }

    function skipWhitespaceBackward(
        position: number,
    ): number {
        while (
            position >= 0
            && /\s/.test(chars[position])
        ) {
            position--
        }

        return position
    }

    function readStringForward(
        position: number,
    ): number {
        const quote = chars[position]

        position++

        while (position < chars.length) {
            if (chars[position] === "\\") {
                position += 2
                continue
            }

            if (chars[position] === quote) {
                return position + 1
            }

            position++
        }

        return position
    }

    function readLongStringForward(
        position: number,
    ): number {
        if (chars[position] !== "[") {
            return position
        }

        let equals = 0
        let cursor = position + 1

        while (
            cursor < chars.length
            && chars[cursor] === "="
        ) {
            equals++
            cursor++
        }

        if (chars[cursor] !== "[") {
            return position
        }

        cursor++

        const closing =
            "]"
            + "=".repeat(equals)
            + "]"

        while (cursor < chars.length) {
            if (
                source.startsWith(
                    closing,
                    cursor,
                )
            ) {
                return cursor + closing.length
            }

            cursor++
        }

        return cursor
    }

    function readNumberForward(
        position: number,
    ): number {
        while (
            position < chars.length
            && /[0-9A-Fa-fxX._]/.test(
                chars[position],
            )
        ) {
            position++
        }

        if (
            chars[position] === "e"
            || chars[position] === "E"
        ) {
            position++

            if (
                chars[position] === "+"
                || chars[position] === "-"
            ) {
                position++
            }

            while (
                position < chars.length
                && /[0-9]/.test(chars[position])
            ) {
                position++
            }
        }

        return position
    }

    function readIdentifierForward(
        position: number,
    ): number {
        while (
            position < chars.length
            && isIdentifierPart(chars[position])
        ) {
            position++
        }

        return position
    }

    function readBalancedForward(
        position: number,
        open: string,
        close: string,
    ): number {
        let depth = 0

        while (position < chars.length) {
            const char = chars[position]

            if (
                char === '"'
                || char === "'"
            ) {
                position = readStringForward(
                    position,
                )
                continue
            }

            if (char === "[") {
                const next =
                    readLongStringForward(
                        position,
                    )

                if (next !== position) {
                    position = next
                    continue
                }
            }

            if (char === open) {
                depth++
            } else if (char === close) {
                depth--

                if (depth === 0) {
                    return position + 1
                }
            }

            position++
        }

        return position
    }

    function readOperandForward(
        position: number,
    ): number {
        position = skipWhitespaceForward(
            position,
        )

        if (position >= chars.length) {
            return position
        }

        const char = chars[position]

        if (
            char === '"'
            || char === "'"
        ) {
            return readStringForward(
                position,
            )
        }

        if (char === "[") {
            const longEnd =
                readLongStringForward(
                    position,
                )

            if (longEnd !== position) {
                return longEnd
            }
        }

        if (/[0-9]/.test(char)) {
            return readNumberForward(
                position,
            )
        }

        if (isIdentifierStart(char)) {
            position =
                readIdentifierForward(
                    position,
                )

            while (position < chars.length) {
                position = skipWhitespaceForward(
                    position,
                )

                if (chars[position] === ".") {
                    position++

                    position = skipWhitespaceForward(
                        position,
                    )

                    if (
                        isIdentifierStart(
                            chars[position],
                        )
                    ) {
                        position =
                            readIdentifierForward(
                                position,
                            )
                        continue
                    }

                    break
                }

                if (chars[position] === ":") {
                    position++

                    position = skipWhitespaceForward(
                        position,
                    )

                    if (
                        isIdentifierStart(
                            chars[position],
                        )
                    ) {
                        position =
                            readIdentifierForward(
                                position,
                            )
                        continue
                    }

                    break
                }

                if (chars[position] === "(") {
                    position =
                        readBalancedForward(
                            position,
                            "(",
                            ")",
                        )
                    continue
                }

                if (chars[position] === "[") {
                    position =
                        readBalancedForward(
                            position,
                            "[",
                            "]",
                        )
                    continue
                }

                break
            }

            return position
        }

        if (char === "(") {
            return readBalancedForward(
                position,
                "(",
                ")",
            )
        }

        if (char === "{") {
            return readBalancedForward(
                position,
                "{",
                "}",
            )
        }

        return position + 1
    }

    function readOperandBackward(
        position: number,
    ): number {
        position = skipWhitespaceBackward(
            position,
        )

        if (position < 0) {
            return position
        }

        const char = chars[position]

        if (char === ")" ) {
            let depth = 0

            while (position >= 0) {
                if (chars[position] === ")") {
                    depth++
                } else if (chars[position] === "(") {
                    depth--

                    if (depth === 0) {
                        position--
                        break
                    }
                }

                position--
            }

            position =
                skipWhitespaceBackward(
                    position,
                )

            while (
                position >= 0
                && (
                    isIdentifierPart(
                        chars[position],
                    )
                    || chars[position] === "."
                    || chars[position] === ":"
                )
            ) {
                position--
            }

            return position + 1
        }

        if (char === "]") {
            let depth = 0

            while (position >= 0) {
                if (chars[position] === "]") {
                    depth++
                } else if (chars[position] === "[") {
                    depth--

                    if (depth === 0) {
                        position--
                        break
                    }
                }

                position--
            }

            position =
                skipWhitespaceBackward(
                    position,
                )

            while (
                position >= 0
                && (
                    isIdentifierPart(
                        chars[position],
                    )
                    || chars[position] === "."
                    || chars[position] === ":"
                )
            ) {
                position--
            }

            return position + 1
        }

        if (char === "}") {
            let depth = 0

            while (position >= 0) {
                if (chars[position] === "}") {
                    depth++
                } else if (chars[position] === "{") {
                    depth--

                    if (depth === 0) {
                        position--
                        break
                    }
                }

                position--
            }

            return position + 1
        }

        if (
            char === '"'
            || char === "'"
        ) {
            const quote = char

            position--

            while (position >= 0) {
                if (chars[position] === "\\") {
                    position -= 2
                    continue
                }

                if (chars[position] === quote) {
                    return position
                }

                position--
            }

            return 0
        }

        if (
            /[0-9A-Fa-f._]/.test(char)
        ) {
            while (
                position >= 0
                && /[0-9A-Fa-fxX._eE+-]/.test(
                    chars[position],
                )
            ) {
                position--
            }

            return position + 1
        }

        if (isIdentifierPart(char)) {
            while (
                position >= 0
                && isIdentifierPart(
                    chars[position],
                )
            ) {
                position--
            }

            let start = position + 1

            while (true) {
                const before =
                    skipWhitespaceBackward(
                        start - 1,
                    )

                if (
                    before >= 0
                    && (
                        chars[before] === "."
                        || chars[before] === ":"
                    )
                ) {
                    start = before

                    let cursor =
                        skipWhitespaceForward(
                            before + 1,
                        )

                    while (
                        cursor < start
                        && isIdentifierPart(
                            chars[cursor],
                        )
                    ) {
                        cursor++
                    }

                    continue
                }

                break
            }

            return start
        }

        return position
    }

    while (i < chars.length) {
        const char = chars[i]

        if (
            char === '"'
            || char === "'"
        ) {
            const end =
                readStringForward(i)

            output.push(
                source.slice(i, end),
            )

            i = end
            continue
        }

        if (char === "[") {
            const end =
                readLongStringForward(i)

            if (end !== i) {
                output.push(
                    source.slice(i, end),
                )

                i = end
                continue
            }
        }

        if (
            char === "-"
            && chars[i + 1] === "-"
        ) {
            let end = i + 2

            if (chars[end] === "[") {
                const longEnd =
                    readLongStringForward(
                        end,
                    )

                if (longEnd !== end) {
                    output.push(
                        source.slice(i, longEnd),
                    )

                    i = longEnd
                    continue
                }
            }

            while (
                end < chars.length
                && chars[end] !== "\n"
                && chars[end] !== "\r"
            ) {
                end++
            }

            output.push(
                source.slice(i, end),
            )

            i = end
            continue
        }

        if (
            char === "/"
            && chars[i + 1] === "/"
        ) {
            const slashPosition = i

            const leftEnd =
                skipWhitespaceBackward(
                    slashPosition - 1,
                )

            const leftStart =
                readOperandBackward(
                    leftEnd,
                )

            const rightStart =
                skipWhitespaceForward(
                    slashPosition + 2,
                )

            const rightEnd =
                readOperandForward(
                    rightStart,
                )

            if (
                leftStart <= leftEnd
                && rightStart < rightEnd
            ) {
                const currentOutput =
                    output.join("")

                const leftText =
                    source.slice(
                        leftStart,
                        leftEnd + 1,
                    )

                const rightText =
                    source.slice(
                        rightStart,
                        rightEnd,
                    )

                const outputLeftIndex =
                    currentOutput.lastIndexOf(
                        leftText,
                    )

                if (outputLeftIndex >= 0) {
                    const before =
                        currentOutput.slice(
                            0,
                            outputLeftIndex,
                        )

                    output.length = 0

                    output.push(before)

                    output.push(
                        `math.floor(${leftText} / ${rightText})`,
                    )

                    i = rightEnd

                    continue
                }
            }
        }

        output.push(char)

        i++
    }

    return output.join("")
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

async function getEngine(): Promise<LuaEngine> {
    if (!enginePromise) {
        enginePromise = createEngine()
    }

    return enginePromise
}

function getErrorMessage(
    error: unknown,
): string {
    if (error instanceof Error) {
        return error.message
    }

    return String(error)
}

function createPrometheusError(
    error: unknown,
): Error {
    return new Error(
        getErrorMessage(error),
    )
}

function getSafePreset(
    presetName: string,
): string {
    if (
        presetName === "Weak"
        || presetName === "Medium"
        || presetName === "Strong"
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

    const presetName =
        getSafePreset(preset)

    const parserCompatibleSource =
        convertFloorDivision(source)

    const script = `
local Prometheus = require("prometheus")

local source = ${luaLongString(
    parserCompatibleSource,
)}

local presetName = ${JSON.stringify(
    presetName,
)}

local originalConfig =
    Prometheus.Presets[presetName]

if not originalConfig then
    error(
        "Preset inválido: "
        .. tostring(presetName)
    )
end

local config = {}

for key, value in pairs(
    originalConfig
) do
    config[key] = value
end

config.LuaVersion = "LuaU"

local originalSteps =
    originalConfig.Steps or {}

local safeSteps = {}

for _, step in ipairs(
    originalSteps
) do
    local name = step.Name

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

local pipeline =
    Prometheus.Pipeline:fromConfig(
        config
    )

local output =
    pipeline:apply(
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
        const result =
            await engine.doString(
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
