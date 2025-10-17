import { createServer } from "http";
import { readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { extname, join, resolve, relative } from "path";
import { URL } from "url";
import mime from "mime";
import { logger } from "../logger.js";
import { directoryListingHtml, invalidPathErrorHtml } from "./htmlTemplates.js";

export class FileServerError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FileServerError";
    this.code = code;
  }
}

export async function startFileServer(dirPath: string, port = 8080) {
  let invalidPathError: FileServerError | null = null;
  const root = resolve(dirPath);
  logger.debug("Starting file server with root:", root, "on port:", port);

  if (!existsSync(root)) {
    logger.debug("Invalid root path for file server:", root);
    invalidPathError = new FileServerError(`The path ${dirPath} does not exist. Please check the path and try again.`, "INVALID_TUNNEL_SERVE_PATH");
  }


  const server = createServer(async (req, res) => {
    try {
      // If invalid root, show an HTML error page
      if (invalidPathError) {
        const html = invalidPathErrorHtml(invalidPathError);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }
      const reqUrl = new URL(req.url || "/", `http://${req.headers.host}`);
      let filePath = join(root, decodeURIComponent(reqUrl.pathname));

      let stats;
      try {
        stats = await stat(filePath);
      } catch {
        res.statusCode = 404;
        res.end("404 Not Found");
        return;
      }

      if (stats.isDirectory() && !reqUrl.pathname.endsWith("/")) {
        res.writeHead(301, { Location: reqUrl.pathname + "/" });
        res.end();
        return;
      }

      // Directory handling
      if (stats.isDirectory()) {
        const indexPath = join(filePath, "index.html");
        if (existsSync(indexPath)) {
          filePath = indexPath;
        } else {
          // No index.html — show directory listing
          const items = await readdir(filePath, { withFileTypes: true });

          const list = items
            .map((item) => {
              // Get the display name
              const name = item.name + (item.isDirectory() ? "/" : "");
              // Construct the current base URL
              const base = new URL(reqUrl.pathname, `http://${req.headers.host}`);
              // Create the full URL
              const hrefUrl = new URL(encodeURIComponent(name), base);
              return `<li><a href="${hrefUrl.pathname}">${name}</a></li>`;
            })
            .join("");

          const relativePath = relative(root, filePath) || "/";
          const html = directoryListingHtml(relativePath, list);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);
          return;
        }
      }

      // Normal file serving
      const content = await readFile(filePath);
      const type = mime.getType(extname(filePath)) || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(content);
    } catch (err: any) {
      logger.debug("Error in handling request", err)
      res.statusCode = 500;
      res.end(`Internal Server Error: ${err.message}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      resolve();
    });
    server.on("error", (err) => {
      logger.debug("Error starting file server", err);
      reject(err);
    });
  });

  return {
    hasInvalidPath: !!invalidPathError,
    error: invalidPathError ? { message: invalidPathError.message, code: invalidPathError.code } : null
  }
}
