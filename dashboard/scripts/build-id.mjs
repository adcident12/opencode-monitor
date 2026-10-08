// A fresh id for each build, read by next.config.ts and copied to public/build.json.
import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"

const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`
writeFileSync(new URL("../.build-id", import.meta.url), id)
console.log(`Build id ${id}`)
