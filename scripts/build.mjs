import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDirectory = path.join(projectRoot, "dist");
const watchMode = process.argv.includes("--watch");

async function buildMainThread() {
  await build({
    absWorkingDir: projectRoot,
    bundle: true,
    entryPoints: ["src/main/code.ts"],
    format: "iife",
    legalComments: "none",
    logLevel: "silent",
    outfile: "dist/code.js",
    platform: "browser",
    sourcemap: "external",
    sourcesContent: true,
    target: "es2022",
  });
}

async function buildUi() {
  const [{ text: bundledScript }, htmlTemplate, stylesheet] = await Promise.all(
    [
      build({
        absWorkingDir: projectRoot,
        bundle: true,
        entryPoints: ["src/ui/ui.ts"],
        format: "iife",
        legalComments: "none",
        logLevel: "silent",
        platform: "browser",
        sourcemap: "inline",
        sourcesContent: true,
        target: "es2022",
        write: false,
      }).then((result) => {
        const output = result.outputFiles?.[0];
        if (output === undefined) {
          throw new Error("UI bundle did not produce JavaScript output.");
        }

        return output;
      }),
      readFile(path.join(projectRoot, "src/ui/index.html"), "utf8"),
      readFile(path.join(projectRoot, "src/ui/styles.css"), "utf8"),
    ],
  );

  const html = htmlTemplate
    .replace(
      "/* INLINE_STYLES */",
      stylesheet.replaceAll("</style", "<\\/style"),
    )
    .replace(
      "/* INLINE_SCRIPT */",
      bundledScript.replaceAll("</script", "<\\/script"),
    );

  if (html === htmlTemplate) {
    throw new Error("UI template markers were not replaced.");
  }

  await writeFile(path.join(distDirectory, "ui.html"), `${html.trimEnd()}\n`);
}

async function buildProject() {
  await mkdir(distDirectory, { recursive: true });
  await Promise.all([buildMainThread(), buildUi()]);
  console.log("Built Figma Design IR plugin.");
}

async function getSourceSignature(directory = path.join(projectRoot, "src")) {
  const entries = await readdir(directory, { withFileTypes: true });
  const signatures = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return getSourceSignature(entryPath);
      }
      if (!entry.isFile()) {
        return "";
      }

      const metadata = await stat(entryPath);
      return `${path.relative(projectRoot, entryPath)}:${metadata.size}:${metadata.mtimeMs}`;
    }),
  );

  return signatures.flat().filter(Boolean).sort().join("|");
}

await buildProject();

if (watchMode) {
  let rebuildPending = false;
  let rebuildRunning = false;
  let pollRunning = false;
  let sourceSignature = await getSourceSignature();

  const runQueuedBuild = async () => {
    if (rebuildRunning) {
      rebuildPending = true;
      return;
    }

    rebuildRunning = true;
    try {
      await buildProject();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown build error";
      console.error(`Build failed: ${message}`);
    } finally {
      rebuildRunning = false;
      if (rebuildPending) {
        rebuildPending = false;
        await runQueuedBuild();
      }
    }
  };

  const pollTimer = setInterval(() => {
    if (pollRunning) {
      return;
    }

    pollRunning = true;
    void getSourceSignature()
      .then(async (nextSignature) => {
        if (nextSignature !== sourceSignature) {
          sourceSignature = nextSignature;
          await runQueuedBuild();
        }
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Unknown watch error";
        console.error(`Watch failed: ${message}`);
      })
      .finally(() => {
        pollRunning = false;
      });
  }, 500);

  process.once("SIGINT", () => {
    clearInterval(pollTimer);
    process.exitCode = 0;
  });

  console.log("Watching plugin source for changes.");
}
