import { Sha256 } from "@aws-crypto/sha256-js";

const encoder = new TextEncoder();

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const supervisorMessageV2ScopedDigest = (
  tenantId: string,
  principal: string,
  kind: string,
  values: readonly string[]
): string => {
  const hash = new Sha256();
  for (const value of [
    "supervisor-message",
    "v2",
    kind,
    tenantId,
    principal,
    ...values,
  ]) {
    hash.update(encoder.encode(`${encoder.encode(value).byteLength}:`));
    hash.update(encoder.encode(value));
    hash.update(new Uint8Array([0]));
  }
  return hex(hash.digestSync());
};
