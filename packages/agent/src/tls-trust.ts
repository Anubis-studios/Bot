import { createHash, X509Certificate } from "node:crypto";
import tls from "node:tls";

// Compromised intermediate SPKIs, including their cross-signed certificates.
// https://emudhra.we-have-a-problem.com/impacted-intermediates.json
const DISTRUSTED_KEYS = new Set([
  "EBED6475C2C2D80FCB199F3FE8DD6E6B3CE60B77EB15D4E42C3DEC0C6F5B5105",
  "43BFFA19D6EF651451F6841E019931E96F6F2EAEFF28AB4B6F1CE4576DE2717B",
  "E0254C7FCDC265E2F0F8A428DABB75AB4AE039B4872D62F5EE57F0877D5A8A41",
  "49DD353DC2B919A3770645117D0E60C16115E7D1BC259EEFE734B00EA434FE5F",
  "63ECEFEE431D49523BC1136C4E72D0206A477086CAF606CD5CF025686C109CF8",
  "5C0660A2B164910D8FF589C18E14552E9E0EC237DCEFE2CB736D41A4811F81A0",
  "EC4FFA1AD0AC88081314B7AAFFEF6A91F97CD57291BB5BA686C5415F5EB4F6B6",
  "92C063D67E8F14DB71D288E11266FFDAF69CBF115F7BAB14F3BC2F68D25E0E30",
]);

// Electron ships a native blocklist. Standalone Node hosts need the same check.
if (!process.versions.electron) {
  const verifyIdentity = tls.checkServerIdentity;
  tls.checkServerIdentity = (hostname, certificate) => {
    const seen = new Set<string>();
    let current: unknown = certificate;
    while (
      typeof current === "object" &&
      current !== null &&
      "raw" in current &&
      current.raw instanceof Uint8Array
    ) {
      const cert = new X509Certificate(current.raw);
      if (seen.has(cert.fingerprint256)) break;
      seen.add(cert.fingerprint256);
      const spki = cert.publicKey.export({ type: "spki", format: "der" });
      if (
        DISTRUSTED_KEYS.has(
          createHash("sha256").update(spki).digest("hex").toUpperCase()
        )
      ) {
        return Object.assign(
          new Error("Certificate chain contains a distrusted CA public key"),
          {
            code: "CERT_REVOKED",
          }
        );
      }
      current =
        "issuerCertificate" in current ? current.issuerCertificate : undefined;
    }
    return verifyIdentity(hostname, certificate);
  };
}
