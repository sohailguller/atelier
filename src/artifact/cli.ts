// Standalone CLI for the artifact contract, so the folder can be checked/inspected without
// re-running extraction.
//   npx tsx src/artifact/cli.ts validate <dir>
//   npx tsx src/artifact/cli.ts load <dir>      # validate + print the resolved DesignSystem
import { validateArtifact } from "./validate.js";
import { loadArtifact } from "./load.js";
import { CURRENT_ARTIFACT_VERSION } from "./schema.js";

const [cmd, dir] = process.argv.slice(2);

if (!cmd || !dir || !["validate", "load"].includes(cmd)) {
  console.error("Usage: tsx src/artifact/cli.ts <validate|load> <design-system-dir>");
  process.exit(1);
}

if (cmd === "validate") {
  const r = validateArtifact(dir);
  console.log(`Artifact contract v${CURRENT_ARTIFACT_VERSION} — validating ${dir}\n`);
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  if (r.ok) {
    console.log(`\n✓ VALID${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ""}`);
  } else {
    console.log(`\n✗ INVALID — ${r.errors.length} error(s):`);
    for (const e of r.errors) console.log(`  - ${e}`);
    process.exit(1);
  }
} else {
  try {
    const ds = loadArtifact(dir);
    const summary = {
      dir: ds.dir,
      source: ds.manifest.source,
      artifactVersion: ds.manifest.artifactVersion,
      visualChannel: ds.manifest.visualChannel,
      recoveryFired: Object.entries(ds.manifest.recovery).filter(([k, v]) => k !== "visualChannel" && v).map(([k]) => k),
      colors: ds.tokens.color,
      fonts: ds.tokens.font,
      typeRoles: Object.keys(ds.tokens.type),
      space: ds.tokens.space,
      radius: ds.tokens.radius,
      fontFiles: ds.fontFiles.length,
      assetFiles: ds.assetFiles.length,
      screenshots: ds.screenshots.length,
      fontsCss: ds.fontsCssPath,
      warnings: ds.warnings,
    };
    console.log(JSON.stringify(summary, null, 2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
