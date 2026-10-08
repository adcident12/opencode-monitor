import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// Testing Library only cleans up by itself when test globals are on; they are not here.
afterEach(cleanup)
