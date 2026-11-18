#!/usr/bin/env node
// Run the whole Vanish stack on your computer with one command:
//
//   npm start
//
// It installs dependencies if they are missing, creates a local upload secret,
// builds the web app, then starts the room Worker (Durable Object + R2 + queue
// emulation) and the Pages server (web app + API) together. Press Ctrl+C to
// stop both. Nothing is deployed and no Cloudflare account is needed.

import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const STATE_DIR = join(ROOT, ".wrangler", "state")
const DEV_VARS = join(ROOT, ".dev.vars")
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js")
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js")
const isWindows = process.platform === "win32"

const color = (code) => (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const bold = color("1")
const dim = color("2")
const green = color("32")
const red = color("31")
const orange = color("33")

const HELP = `
${bold("npm start")} runs Vanish locally at http://localhost:8788

Options (put them after a double dash, e.g. ${bold("npm start -- --port 3000")}):
  --port <number>   Port for the web app (default 8788, or the next free one)
  --skip-build      Reuse the existing dist/ build instead of rebuilding
  --verbose         Show the full Wrangler logs, including every request
  --help            Show this message
`

function fail(message) {
  console.error(`\n${red("✗")} ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { port: undefined, skipBuild: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      console.log(HELP)
      process.exit(0)
    } else if (arg === "--skip-build") options.skipBuild = true
    else if (arg === "--verbose") options.verbose = true
    else if (arg === "--port" || arg.startsWith("--port=")) {
      const value = arg.includes("=") ? arg.split("=")[1] : argv[++i]
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`"${value}" is not a valid port number.`)
      options.port = port
    } else fail(`Unknown option "${arg}". Run ${bold("npm start -- --help")} to see the options.`)
  }
  if (options.port === undefined && process.env.PORT) {
    const port = Number(process.env.PORT)
    if (Number.isInteger(port) && port > 0 && port < 65536) options.port = port
  }
  return options
}

function step(message) {
  console.log(`${orange("›")} ${message}`)
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0])
  if (major < 22) {
    fail(
      `Vanish needs Node.js 22 or newer, and this is Node ${process.versions.node}.\n` +
        `  Install the current LTS from https://nodejs.org and run ${bold("npm start")} again.`,
    )
  }
}

function installDependencies() {
  if (existsSync(WRANGLER) && existsSync(VITE)) return
  step("Installing dependencies (first run only, this can take a minute)…")
  // Inside `npm start`, npm tells us where its own CLI lives. Use it directly so
  // this works the same on macOS, Linux and Windows.
  const npmCli = process.env.npm_execpath
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, "install"], { cwd: ROOT, stdio: "inherit" })
    : spawnSync("npm", ["install"], { cwd: ROOT, stdio: "inherit", shell: isWindows })
  if (result.status !== 0) fail("npm install failed. Fix the error above, then run npm start again.")
}

// Uploads are signed with UPLOAD_SECRET, and the API refuses uploads without one.
// Locally we generate a random value once and keep it in .dev.vars, which
// Wrangler reads automatically and git ignores.
function ensureUploadSecret() {
  const existing = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, "utf8") : ""
  if (/^\s*UPLOAD_SECRET\s*=\s*\S/m.test(existing)) return
  const secret = randomBytes(32).toString("base64url")
  const block = `# Local-only secret for signing media uploads, created by npm start.\nUPLOAD_SECRET=${secret}\n`
  if (existing) appendFileSync(DEV_VARS, (existing.endsWith("\n") ? "" : "\n") + block)
  else writeFileSync(DEV_VARS, block)
  step(`Created a local upload secret in ${bold(".dev.vars")}`)
}

function build(skip) {
  if (skip && existsSync(join(ROOT, "dist", "index.html"))) {
    step("Skipping the build, using the existing dist/ folder")
    return
  }
  step("Building the web app…")
  const result = spawnSync(process.execPath, [VITE, "build", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" })
  if (result.status !== 0) fail("The build failed. Fix the error above, then run npm start again.")
}

function isPortFree(port) {
  return new Promise((done) => {
    const server = createServer()
    server.once("error", () => done(false))
    server.once("listening", () => server.close(() => done(true)))
    server.listen(port, "127.0.0.1")
  })
}

async function findPort(preferred, { strict = false, avoid = [] } = {}) {
  for (let port = preferred; port < preferred + 50; port++) {
    if (avoid.includes(port)) continue
    if (await isPortFree(port)) return port
    if (strict) fail(`Port ${port} is already in use. Stop whatever is using it, or pick another with --port.`)
  }
  fail(`Could not find a free port near ${preferred}.`)
}

const children = new Set()
let shuttingDown = false

// Locally, Wrangler can't hand a WebSocket from the Pages functions to the room
// Durable Object in the other process, so every live-connection attempt logs an
// error with a stack trace before the app quietly falls back to polling. Those
// errors are expected and harmless here, so hide them (and their stack frames)
// unless --verbose is on, and explain once instead.
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "")
const isStackLine = (line) => /^\s+(at |stack: )/.test(plain(line))
let explainedPolling = false

function localNoiseFilter() {
  let dropping = false
  let held = null // a "SyntaxError" line we can only judge once we see its stack
  const explain = () => {
    if (explainedPolling) return
    explainedPolling = true
    console.log(
      dim("  Note: live updates use polling when running locally, so messages can take a second to appear."),
    )
  }
  const flushHeld = (write) => {
    if (held) for (const line of held) write(line)
    held = null
  }
  return {
    push(line, write) {
      const text = plain(line)
      if (held) {
        if (isStackLine(line)) {
          held.push(line)
          if (text.includes("handlePrettyErrorRequest")) {
            held = null
            dropping = true
            explain()
          }
          return
        }
        flushHeld(write)
      }
      if (dropping && isStackLine(line)) return
      dropping = false
      if (/Web Socket request did not return status 101/.test(text)) {
        dropping = true
        explain()
        return
      }
      if (/kj::getCaughtExceptionAsKj\(\).*disconnected: .*(Broken pipe|Connection reset by peer)/.test(text)) {
        dropping = true
        return
      }
      if (/SyntaxError: Unexpected end of JSON input/.test(text)) {
        held = [line]
        return
      }
      write(line)
    },
  }
}

function startWrangler(name, args, verbose) {
  const logArgs = verbose ? [] : ["--log-level", "warn"]
  const child = spawn(process.execPath, [WRANGLER, ...args, ...logArgs], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: process.stdout.isTTY ? "1" : "0" },
  })
  children.add(child)
  const prefix = dim(`[${name}]`)
  const forward = (stream, out) => {
    let buffered = ""
    const filter = verbose ? null : localNoiseFilter()
    const write = (line) => out.write(`${prefix} ${line}\n`)
    stream.on("data", (chunk) => {
      buffered += chunk.toString()
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        if (filter) filter.push(line, write)
        else write(line)
      }
    })
  }
  forward(child.stdout, process.stdout)
  forward(child.stderr, process.stderr)
  child.on("exit", (code, signal) => {
    children.delete(child)
    if (shuttingDown) return
    console.error(`\n${red("✗")} The ${name} server stopped unexpectedly (${signal ?? `exit code ${code}`}).`)
    if (!verbose) console.error(`  Run ${bold("npm start -- --verbose")} to see the full logs.`)
    shutdown(1)
  })
  return child
}

async function waitFor(url, child, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.status < 500) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.error(`\n${red("✗")} The ${label} did not start within ${timeoutMs / 1000} seconds.`)
  shutdown(1)
}

function stopChild(child) {
  if (child.exitCode !== null) return
  if (isWindows) {
    // Wrangler runs workerd as a grandchild; /T ends the whole tree.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    child.kill("SIGINT")
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) stopChild(child)
  const force = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL")
    process.exit(code)
  }, 5_000)
  force.unref()
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check)
      process.exit(code)
    }
  }, 100)
}

process.on("SIGINT", () => {
  console.log(`\n${dim("Stopping Vanish…")}`)
  shutdown(0)
})
process.on("SIGTERM", () => shutdown(0))

async function main() {
  const options = parseArgs(process.argv.slice(2))
  console.log(`\n${bold("Vanish")} ${dim("· local setup")}\n`)
  checkNode()
  installDependencies()
  ensureUploadSecret()
  build(options.skipBuild)

  const webPort = await findPort(options.port ?? 8788, { strict: options.port !== undefined })
  const workerPort = await findPort(8787, { avoid: [webPort] })

  step(`Starting the room server ${dim(`(port ${workerPort})`)}…`)
  const worker = startWrangler(
    "worker",
    ["dev", "-c", "room-worker/wrangler.toml", "--port", String(workerPort), "--persist-to", STATE_DIR],
    options.verbose,
  )
  await waitFor(`http://127.0.0.1:${workerPort}/health`, worker, "room server")
  if (shuttingDown) return

  step(`Starting the web app ${dim(`(port ${webPort})`)}…`)
  const pages = startWrangler(
    "pages",
    [
      "pages",
      "dev",
      "dist",
      "--port",
      String(webPort),
      "--persist-to",
      STATE_DIR,
      // Every local request comes from the same address, so the production
      // per-IP limits (e.g. 10 new rooms an hour) would quickly lock you out
      // while testing. This flag turns them off for local runs only.
      "--binding",
      "E2E_MODE=1",
    ],
    options.verbose,
  )
  await waitFor(`http://127.0.0.1:${webPort}/`, pages, "web app")
  if (shuttingDown) return

  const url = `http://localhost:${webPort}`
  console.log(`
${green("✓")} ${bold("Vanish is running")}

    Open      ${bold(url)}
    Try it    Create a room, then open the invite link in a private window
              to chat with yourself.
    Stop      Press ${bold("Ctrl+C")}

  ${dim("Rooms and messages are stored in .wrangler/state on this computer only.")}
`)
}

await main()
