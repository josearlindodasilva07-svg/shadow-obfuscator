import { LuaFactory } from "wasmoon"
import glueWasmUrl from "wasmoon/dist/glue.wasm?url"

import luaSources from "virtual:prometheus-lua"

type LuaEngine = Awaited<
  ReturnType<LuaFactory["createEngine"]>
>

let enginePromise: Promise<LuaEngine> | null = null

function luaLongString(value: string): string {
  const equals = "=".repeat(
    Math.max(
      0,
      ...Array.from(
        value.matchAll(/\](=*)\]/g),
        (match) => match[1].length + 1,
      ),
    ),
  )

  return `[${equals}[${value}]${equals}]`
}

function createBootstrap(): string {
  const modules = Object.entries(luaSources)
    .map(([name, source]) => {
      return `
package.preload[${JSON.stringify(name)}] = function()
${source}
end
`
    })
    .join("\n")

  return `
${modules}

return true
`
}

async function createEngine(): Promise<LuaEngine> {
  const factory = new LuaFactory(glueWasmUrl)

  const engine = await factory.createEngine()

  await engine.doStringAsync(createBootstrap())

  return engine
}

async function getEngine(): Promise<LuaEngine> {
  if (!enginePromise) {
    enginePromise = createEngine()
  }

  return enginePromise
}

function getModuleSource(name: string): string {
  const source = luaSources[name]

  if (!source) {
    throw new Error(
      `Módulo Lua não encontrado: ${name}`,
    )
  }

  return source
}

export async function obfuscateLua(
  code: string,
  preset = "Medium",
): Promise<string> {
  if (!code.trim()) {
    throw new Error("Nenhum código Luau foi fornecido.")
  }

  const engine = await getEngine()

  const prometheusSource =
    getModuleSource("prometheus")

  const configSource =
    getModuleSource("config")

  const script = `
${configSource}

${prometheusSource}

local source = ${luaLongString(code)}

local Prometheus = require("prometheus")

local config = Prometheus.Config

if ${JSON.stringify(preset)} == "Weak" then
    config = Prometheus.Config:extend({
        NameGenerators = {},
    })
elseif ${JSON.stringify(preset)} == "Strong" then
    config = Prometheus.Config:extend({
        LuaVersion = "LuaU",
    })
end

local result = Prometheus:obfuscate(source, config)

return result
`

  const result = await engine.doStringAsync(script)

  if (typeof result !== "string") {
    throw new Error(
      "O Prometheus não retornou um código válido.",
    )
  }

  return result
}
