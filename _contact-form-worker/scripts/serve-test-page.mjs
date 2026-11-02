// Serves test.html and form-snippet.html on http://localhost:8788 so the test
// page has a real origin the local Worker can allow. No dependencies.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PORT = 8788;
const root = fileURLToPath(new URL("..", import.meta.url));

const routes = {
  "/": "test.html",
  "/form-snippet.html": "form-snippet.html",
};

createServer(async (req, res) => {
  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Stand-in for the live thank-you page, for the no-JavaScript redirect.
  if (path === "/thanks") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Thanks</title><h1>Thanks</h1><p>The form posted and the Worker redirected here.</p>");
    return;
  }

  const file = routes[path];
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(await readFile(root + file));
}).listen(PORT, () => {
  console.log(`Test page: http://localhost:${PORT}/`);
});
