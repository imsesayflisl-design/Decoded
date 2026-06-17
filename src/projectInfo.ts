// Detects what KIND of project the open workspace is, from its manifest files
// (package.json, requirements.txt, go.mod, …). Used to tell the user what
// they're building and to give the AI a little project context. No AI call.
import * as vscode from "vscode";

export interface ProjectInfo {
  // Short human label, e.g. "VS Code extension (TypeScript)".
  label: string;
  // One or two beginner-friendly sentences about what the project is.
  explanation: string;
}

const EXCLUDE = "**/{node_modules,.git,dist,out,build,.next,vendor}/**";

// Finds the first matching manifest file anywhere near the workspace root.
async function findManifest(glob: string): Promise<vscode.Uri | undefined> {
  const hits = await vscode.workspace.findFiles(glob, EXCLUDE, 1);
  return hits[0];
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.getText();
  } catch {
    return undefined;
  }
}

// Parses package.json and classifies the project from its dependencies.
function classifyNode(pkgText: string, hasTsConfig: boolean): ProjectInfo {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    // Malformed package.json — still clearly a Node project.
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (name: string): boolean => name in deps;
  const lang =
    hasTsConfig || has("typescript") ? "TypeScript" : "JavaScript";

  // Most specific first.
  if (pkg.engines?.vscode || has("@types/vscode") || has("vscode")) {
    return {
      label: `VS Code extension (${lang})`,
      explanation: `This is a VS Code extension written in ${lang} — it adds features to the VS Code editor itself.`,
    };
  }
  if (has("next")) {
    return {
      label: `Next.js web app (${lang})`,
      explanation: `This is a Next.js web application (${lang}) — a React framework that renders pages on the server and the browser.`,
    };
  }
  if (has("react-native") || has("expo")) {
    return {
      label: `React Native mobile app (${lang})`,
      explanation: `This is a React Native mobile app (${lang}) — it builds iOS/Android apps from one codebase.`,
    };
  }
  if (has("@angular/core")) {
    return {
      label: `Angular web app (${lang})`,
      explanation: `This is an Angular web application (${lang}).`,
    };
  }
  if (has("svelte") || has("@sveltejs/kit")) {
    return {
      label: `Svelte web app (${lang})`,
      explanation: `This is a Svelte web application (${lang}).`,
    };
  }
  if (has("vue")) {
    return {
      label: `Vue web app (${lang})`,
      explanation: `This is a Vue web application (${lang}).`,
    };
  }
  if (has("react")) {
    return {
      label: `React web app (${lang})`,
      explanation: `This is a React web application (${lang}) — a UI built from components that run in the browser.`,
    };
  }
  if (has("electron")) {
    return {
      label: `Electron desktop app (${lang})`,
      explanation: `This is an Electron desktop application (${lang}) — a desktop app built with web technology.`,
    };
  }
  if (has("@nestjs/core") || has("express") || has("fastify") || has("koa")) {
    return {
      label: `Node.js backend/API (${lang})`,
      explanation: `This is a Node.js backend/server (${lang}) — it handles requests and serves data, not a user interface.`,
    };
  }
  return {
    label: `Node.js project (${lang})`,
    explanation: `This is a Node.js project (${lang}).`,
  };
}

// Detects the project type, or undefined if there's no recognizable manifest.
export async function detectProjectType(): Promise<ProjectInfo | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return undefined;
  }

  // Node / web / extension — package.json is the richest signal.
  const pkgUri = await findManifest("**/package.json");
  if (pkgUri) {
    const text = (await readText(pkgUri)) ?? "{}";
    const hasTsConfig = Boolean(await findManifest("**/tsconfig.json"));
    return classifyNode(text, hasTsConfig);
  }

  // Python.
  if (
    (await findManifest("**/pyproject.toml")) ||
    (await findManifest("**/requirements.txt")) ||
    (await findManifest("**/setup.py"))
  ) {
    const reqs =
      (await (async () => {
        const u =
          (await findManifest("**/requirements.txt")) ??
          (await findManifest("**/pyproject.toml"));
        return u ? await readText(u) : undefined;
      })()) ?? "";
    const lc = reqs.toLowerCase();
    const framework = lc.includes("django")
      ? "Django web "
      : lc.includes("flask")
        ? "Flask web "
        : lc.includes("fastapi")
          ? "FastAPI "
          : "";
    return {
      label: `Python ${framework}project`.replace("  ", " "),
      explanation: `This is a Python ${framework}project.`.replace("  ", " "),
    };
  }

  // Other ecosystems by their lockfile/manifest.
  const simple: { glob: string; label: string; explanation: string }[] = [
    { glob: "**/go.mod", label: "Go project", explanation: "This is a Go project." },
    { glob: "**/Cargo.toml", label: "Rust project", explanation: "This is a Rust project." },
    { glob: "**/pom.xml", label: "Java (Maven) project", explanation: "This is a Java project built with Maven." },
    { glob: "**/build.gradle", label: "Java/Kotlin (Gradle) project", explanation: "This is a Java/Kotlin project built with Gradle." },
    { glob: "**/Gemfile", label: "Ruby project", explanation: "This is a Ruby project." },
    { glob: "**/composer.json", label: "PHP project", explanation: "This is a PHP project." },
    { glob: "**/*.csproj", label: ".NET (C#) project", explanation: "This is a .NET project written in C#." },
  ];
  for (const s of simple) {
    if (await findManifest(s.glob)) {
      return { label: s.label, explanation: s.explanation };
    }
  }

  return undefined;
}
