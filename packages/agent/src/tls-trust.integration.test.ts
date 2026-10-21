import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/tls/${name}`, import.meta.url));

test("standalone Node rejects compromised CA keys without dropping private CAs", async () => {
  let intercepted = 0;
  const server = (cert: string, compromised = false) =>
    createServer(
      { cert: fixture(cert), key: fixture("test-key.pem") },
      (_request, response) => {
        if (compromised) intercepted++;
        response.end("healthy");
      }
    );
  const compromised = server("compromised-cert.pem", true);
  const healthy = server("healthy-cert.pem");
  await Promise.all(
    [compromised, healthy].map(
      (listener) =>
        new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    )
  );
  const url = (listener: ReturnType<typeof server>) => {
    const address = listener.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing test listener");
    return `https://127.0.0.1:${address.port}`;
  };
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      `import https from "node:https";
       import tls from "node:tls";
       import assert from "node:assert/strict";
       await import(${JSON.stringify(new URL("./tls-trust.ts", import.meta.url).href)});
       const ca = ${JSON.stringify(fixture("compromised-root.pem").toString())};
       tls.setDefaultCACertificates([...tls.getCACertificates("default"), ca,
         ${JSON.stringify(fixture("healthy-cert.pem").toString())}]);
       const request = url => new Promise((resolve, reject) => {
         https.get(url, {ca, agent:false}, response => {
           response.resume(); resolve(response.statusCode);
         }).on("error", reject);
       });
       await assert.rejects(request(${JSON.stringify(url(compromised))}), {code:"CERT_REVOKED"});
       await assert.rejects(fetch(${JSON.stringify(url(compromised))}), error => error.cause?.code === "CERT_REVOKED");
       assert.equal(await (await fetch(${JSON.stringify(url(healthy))})).text(), "healthy");
       console.log("TLS policy passed");`,
    ]);
    expect(stdout.trim()).toBe("TLS policy passed");
    expect(intercepted).toBe(0);
  } finally {
    for (const listener of [compromised, healthy])
      listener.closeAllConnections();
    await Promise.all(
      [compromised, healthy].map(
        (listener) =>
          new Promise<void>((resolve) => listener.close(() => resolve()))
      )
    );
  }
});
