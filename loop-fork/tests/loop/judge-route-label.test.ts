import { expect, test } from "bun:test";
import { judgeRouteLabel } from "../../src/loop/judge-route-label";

test("judge route shows configured Qwen and endpoint, not inferred backend", () => {
  expect(
    judgeRouteLabel(
      "mlx-community/Qwen3.8-27B-4bit",
      "http://127.0.0.1:8084/v1"
    )
  ).toBe(
    " judge cfg mlx-community/Qwen3.8-27B-4bit · endpoint http://127.0.0.1:8084"
  );
});

test("judge location strips credentials, path, query and fragments", () => {
  const row = judgeRouteLabel(
    "Qwen",
    "https://user:secret@host.example:8443/private?token=hidden#secret"
  );
  expect(row).toBe(" judge cfg Qwen · endpoint https://host.example:8443");
  for (const secret of ["user", "secret", "private", "hidden"]) {
    expect(row).not.toContain(secret);
  }
  expect(judgeRouteLabel("Qwen", "not-a-url-secret")).toContain(
    "endpoint unavailable"
  );
  expect(judgeRouteLabel("Qwen", "file:///secret")).toContain(
    "endpoint unavailable"
  );
});
