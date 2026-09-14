// Test-only image entry point: loopback HTTP origin inside a network-none container.
import { createServer } from "node:http";
const server = createServer((request, response) => {
  if (request.url === "/download") { response.setHeader("content-disposition", 'attachment; filename="fixture.txt"'); response.end("container artifact"); return; }
  response.setHeader("content-type", "text/html");
  response.end('<!doctype html><title>Container browser fixture</title><input id="name"><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Apply</button><p id="result"></p><input type="file" id="file" onchange="this.files[0].text().then(t=>document.querySelector(\'#uploaded\').textContent=t)"><p id="uploaded"></p><a id="download" href="/download">Download</a>');
});
await new Promise((resolve) => server.listen(8765, "127.0.0.1", resolve));
await import("/opt/station/packages/station-browser-use/dist/container-worker.js");
