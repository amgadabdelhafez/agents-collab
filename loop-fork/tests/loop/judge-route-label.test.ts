import { expect, test } from "bun:test";
import {
  helperModelLabel,
  judgeRouteLabel,
  judgeRuntimeLabel,
} from "../../src/loop/judge-route-label";

test("helper model keeps version and size instead of collapsing to family", () => {
  expect(helperModelLabel("/Users/example/qwen38-27b/model-10c35caa")).toBe(
    "Qwen3.8-27B"
  );
  expect(helperModelLabel("mlx-community/Qwen3.8-27B-4bit")).toBe(
    "Qwen3.8-27B-4bit"
  );
  expect(helperModelLabel(undefined)).toBe("—");
});

test("runtime row uses attested model, compute and host without technical route", () => {
  expect(
    judgeRuntimeLabel("/private/model-pin", {
      model: "Qwen3.8 27B 4-bit",
      compute: "GPU (Apple M5 Pro / Metal)",
      host: "sweetmac14",
    })
  ).toBe(" Qwen3.8 27B 4-bit · GPU (Apple M5 Pro / Metal) · sweetmac14");
  expect(judgeRuntimeLabel("Qwen", {})).toBe(
    " Qwen · compute unknown · host unknown"
  );
});

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

test("local pinned selectors retain artifact identity without the full home path", () => {
  expect(
    judgeRouteLabel(
      "/Users/example/.local/share/loop/qwen38-27b/model-10c35caa",
      "http://127.0.0.1:8084"
    )
  ).toBe(
    " judge cfg qwen38-27b/model-10c35caa · endpoint http://127.0.0.1:8084"
  );
});
