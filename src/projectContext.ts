// Lightweight project inspection for "Diagnose" — reads only small, specific
// files (package.json) and checks for the existence of node_modules and a
// lockfile, using workspace file APIs. Never scans/opens large files.
import * as vscode from "vscode";

export interface ProjectContext {
  hasPackageJson: boolean;
  dependencies: string[];
  scripts: string[];
  hasNodeModules: boolean;
  lockfile: string | null;
  packageManager: "npm" | "yarn" | "pnpm" | "unknown";
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

// Gathers compact context about the first workspace folder, or undefined when
// no folder is open.
export async function gatherProjectContext(): Promise<
  ProjectContext | undefined
> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const root = folder.uri;

  let hasPackageJson = false;
  let dependencies: string[] = [];
  let scripts: string[] = [];
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(root, "package.json")
    );
    hasPackageJson = true;
    const pkg = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    dependencies = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    scripts = Object.keys(pkg.scripts ?? {});
  } catch {
    // No package.json, or it didn't parse — leave the defaults.
  }

  const hasNodeModules = await exists(vscode.Uri.joinPath(root, "node_modules"));

  // Lockfile drives the package-manager choice.
  let lockfile: string | null = null;
  let packageManager: ProjectContext["packageManager"] = "unknown";
  if (await exists(vscode.Uri.joinPath(root, "pnpm-lock.yaml"))) {
    lockfile = "pnpm-lock.yaml";
    packageManager = "pnpm";
  } else if (await exists(vscode.Uri.joinPath(root, "yarn.lock"))) {
    lockfile = "yarn.lock";
    packageManager = "yarn";
  } else if (await exists(vscode.Uri.joinPath(root, "package-lock.json"))) {
    lockfile = "package-lock.json";
    packageManager = "npm";
  } else if (hasPackageJson) {
    packageManager = "npm"; // sensible default when only package.json exists
  }

  return {
    hasPackageJson,
    dependencies,
    scripts,
    hasNodeModules,
    lockfile,
    packageManager,
  };
}

// Renders the context as a compact, AI-friendly summary (deps capped to keep
// the request small).
export function formatProjectContext(ctx: ProjectContext): string {
  if (!ctx.hasPackageJson) {
    return "No package.json found in the workspace root (this may not be a Node project).";
  }
  const deps =
    ctx.dependencies.length > 40
      ? ctx.dependencies.slice(0, 40).join(", ") + ", …"
      : ctx.dependencies.join(", ") || "none";
  return [
    `package.json: yes`,
    `node_modules installed: ${ctx.hasNodeModules ? "yes" : "no"}`,
    `lockfile: ${ctx.lockfile ?? "none"}`,
    `package manager: ${ctx.packageManager}`,
    `scripts: ${ctx.scripts.join(", ") || "none"}`,
    `dependencies: ${deps}`,
  ].join("\n");
}
