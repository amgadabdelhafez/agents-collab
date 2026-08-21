# webui-readonly-mvp-direct Research

## Research Question

What is the smallest established frontend stack that can implement the reviewed
Loop control-surface design inside the existing Bun/TypeScript repository while
remaining fast, accessible, dependency-light, and easy to embed in the future
compiled `loop web` server?

## Candidates Reviewed

- **React with TypeScript.** The binding product plan already selects React and
  explicitly forbids a UI kit and state framework. React's official guidance
  supports incremental adoption in an existing project and documents typed
  `.tsx` components. This fits a presentation layer whose server contract will
  arrive separately.
- **Vite.** The reviewed plan selects Vite. The official guide provides a
  React/TypeScript template, a fast local development server, and a production
  asset build. Its configurable root/outDir lets the UI live inside
  `src/webui/` without creating a second repository or framework.
- **Existing Loop Web UI specification.** The committed spec already defines
  information architecture, data-quality language, accessibility expectations,
  read-only policy, responsive structure, and future DTO boundaries. Reuse the
  contract rather than inventing another dashboard model.
- **Native CSS and browser APIs.** CSS grid, container/media queries, semantic
  HTML, `details`, buttons, local component state, and `prefers-reduced-motion`
  cover this slice without Tailwind, a component library, a state store, or a
  routing dependency.

## Open-Source Patterns

- Keep remote data behind a small typed adapter and make fixture data implement
  the identical interface.
- Derive grouping, filtering, and sorting with pure functions, then test those
  functions separately from rendering.
- Build status with text and shape as well as color, preserve visible focus,
  and let motion follow the user's reduced-motion preference.
- Bound activity lists and histories at the data boundary instead of rendering
  unbounded logs.
- Use design tokens for semantic colors, spacing, typography, density, and
  focus so the shell and workspace share one visual system.

## Reuse Decision

Adapt the existing reviewed product contract with React, TypeScript, and Vite.
Add only React, React DOM, Vite, the official React Vite plugin, and React type
packages. Build custom components with native CSS. Use deterministic fixtures
through a typed adapter now, then replace that adapter with T-02 fetch/SSE
without changing the component contracts. This is the shortest path to a real
rendered product while keeping runtime authority and mutation completely out of
scope.

## Sources

- https://react.dev/learn/add-react-to-an-existing-project
- https://react.dev/learn/typescript
- https://react.dev/learn/build-a-react-app-from-scratch
- https://vite.dev/guide/
- `../specs/webui-control-plane/{spec,plan,tasks,verify}.md`
