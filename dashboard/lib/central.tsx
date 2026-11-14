"use client"

import { createContext, useContext } from "react"

// OpenCode Central: true on the hub (the snapshot has `central`). Parts that need text the hub does not keep
// (the Replay tab and the links to it) leave themselves out.
const CentralContext = createContext(false)

export const CentralProvider = CentralContext.Provider

export function useCentral(): boolean {
  return useContext(CentralContext)
}
