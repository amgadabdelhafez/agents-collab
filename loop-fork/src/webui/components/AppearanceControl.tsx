// biome-ignore-all lint/style/useFilenamingConvention: React component files use PascalCase in this Web UI.
import type { ChangeEvent } from "react";

import { type AppearanceMode, parseAppearanceMode } from "../theme";

interface AppearanceControlProps {
  readonly mode: AppearanceMode;
  readonly onChange: (mode: AppearanceMode) => void;
}

export function AppearanceControl({ mode, onChange }: AppearanceControlProps) {
  const selectMode = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextMode = parseAppearanceMode(event.currentTarget.value);
    if (nextMode) {
      onChange(nextMode);
    }
  };

  return (
    <label className="appearance-control">
      <span aria-hidden="true" className="appearance-control-icon">
        ◐
      </span>
      <span className="appearance-control-label">Appearance</span>
      <select aria-label="Appearance mode" onChange={selectMode} value={mode}>
        <option value="system">Follow system</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
