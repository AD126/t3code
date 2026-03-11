import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Effect, Option } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

const FAVICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
];

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
];

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
}

function resolveIconHref(projectCwd: string, href: string): string[] {
  const clean = href.replace(/^\//, "");
  return [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
}

function isPathWithinProject(projectCwd: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(projectCwd), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isFile(candidatePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(candidatePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function resolveFaviconPath(projectCwd: string): Promise<string | null> {
  for (const candidate of FAVICON_CANDIDATES) {
    const candidatePath = path.join(projectCwd, candidate);
    if (!isPathWithinProject(projectCwd, candidatePath)) {
      continue;
    }
    if (await isFile(candidatePath)) {
      return candidatePath;
    }
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    const sourceFilePath = path.join(projectCwd, sourceFile);
    let content: string;
    try {
      content = await fs.promises.readFile(sourceFilePath, "utf8");
    } catch {
      continue;
    }

    const href = extractIconHref(content);
    if (!href) {
      continue;
    }

    const candidates = resolveIconHref(projectCwd, href);
    for (const candidatePath of candidates) {
      if (!isPathWithinProject(projectCwd, candidatePath)) {
        continue;
      }
      if (await isFile(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return null;
}

export const handleProjectFaviconRequest = (projectCwd: string | null) =>
  Effect.gen(function* () {
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconPath = yield* Effect.promise(() => resolveFaviconPath(projectCwd));
    if (!faviconPath) {
      return HttpServerResponse.text(FALLBACK_FAVICON_SVG, {
        contentType: "image/svg+xml",
        headers: { "Cache-Control": "public, max-age=3600" },
      });
    }

    const data = yield* Effect.promise(() => fs.promises.readFile(faviconPath)).pipe(Effect.option);
    if (Option.isNone(data)) {
      return HttpServerResponse.text("Read error", { status: 500 });
    }

    const ext = path.extname(faviconPath).toLowerCase();
    const contentType = FAVICON_MIME_TYPES[ext] ?? "application/octet-stream";
    return HttpServerResponse.uint8Array(new Uint8Array(data.value), {
      contentType,
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  });

export function tryHandleProjectFaviconRequest(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== "/api/project-favicon") {
    return false;
  }

  void Effect.runPromise(handleProjectFaviconRequest(url.searchParams.get("cwd")))
    .then((response) => {
      const webResponse = HttpServerResponse.toWeb(response);
      res.statusCode = webResponse.status;
      for (const [header, value] of webResponse.headers.entries()) {
        res.setHeader(header, value);
      }
      return webResponse
        .arrayBuffer()
        .then((buffer) => {
          res.end(Buffer.from(buffer));
        })
        .catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
          }
          res.end("Read error");
        });
    })
    .catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end("Read error");
    });
  return true;
}
