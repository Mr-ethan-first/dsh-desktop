// Local build helper: strip the platform-specific optional binary sub-packages of
// @openai/codex and @anthropic-ai/claude-agent-sdk from resolution.
// These are optional native binaries (~100-140MB each) that cannot be fetched in
// this sandboxed network and are not required for building/testing the harness or
// the desktop client. The subagent-codex / subagent-claude-code providers simply
// will not have the native binary available; all other functionality is unaffected.
function readPackage(pkg) {
  if (pkg.name === '@openai/codex' && pkg.optionalDependencies) {
    for (const dep of Object.keys(pkg.optionalDependencies)) {
      if (dep.startsWith('@openai/codex-')) delete pkg.optionalDependencies[dep];
    }
  }
  if (pkg.name === '@anthropic-ai/claude-agent-sdk' && pkg.optionalDependencies) {
    for (const dep of Object.keys(pkg.optionalDependencies)) {
      if (dep.startsWith('@anthropic-ai/claude-agent-sdk-')) delete pkg.optionalDependencies[dep];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
