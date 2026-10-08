// Copies the static export (out/) to ../public, which the monitor server serves.
// Run through `npm run build`; the result is committed so that people who only run the
// monitor never need npm.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "..", "out")
const target = join(here, "..", "..", "public")

if (!existsSync(join(out, "index.html"))) {
  console.error("No out/index.html: run `next build` first.")
  process.exit(1)
}
rmSync(target, { recursive: true, force: true })
cpSync(out, target, { recursive: true })
// Lets the monitor tell an open page which build it is serving now.
const id = readFileSync(join(here, "..", ".build-id"), "utf8").trim()
writeFileSync(join(target, "build.json"), JSON.stringify({ id }) + "\n")
console.log(`Copied ${out} -> ${target}`)
