// Entry re-export so the dsh cordis loader (which resolves @deepseek-ai/dsh-modlens
// to <pkg>/src/index.ts by convention) finds the cordis plugin, not the CLI library.
// The actual plugin lives in ../dsh/index.js (plain JS, dependency-free).
export * from '../dsh/index.js'
