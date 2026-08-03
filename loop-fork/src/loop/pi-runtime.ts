import type {
  Api,
  Model,
  OpenAICompletionsCompat,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ModelRuntime,
  ResourceLoader,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const PI_VERSION = "0.82.1";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const LOCAL_DUMMY_KEY = "loop-local-no-key";
const NANNY_MAX_TOKENS = 3200;
const TRAILING_SLASH_RE = /\/+$/;
const CHAT_COMPLETIONS_SUFFIX_RE = /\/chat\/completions$/i;

export interface PiProviderSpec {
  apiKey?: string;
  contextWindow?: number;
  endpoint: string;
  maxTokens?: number;
  model: string;
  provider: "nanny" | "au-pair";
  providerSort?: "price" | "throughput" | "latency" | "exacto";
}

export interface PiUsage {
  cachedInputTokens: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface PiTextCompletion {
  model: string;
  piVersion: string;
  provider: string;
  stopReason: string;
  text: string;
  usage: PiUsage;
}

export interface PiSessionRuntime {
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  providerId: string;
}

const normalizedBaseUrl = (endpoint: string): string => {
  const value = endpoint.trim().replace(TRAILING_SLASH_RE, "");
  return value.replace(CHAT_COMPLETIONS_SUFFIX_RE, "");
};

const isOpenRouter = (endpoint: string): boolean =>
  normalizedBaseUrl(endpoint) === OPENROUTER_BASE_URL;

export const normalizePiUsage = (usage: Usage): PiUsage => ({
  cachedInputTokens: usage.cacheRead,
  cost: usage.cost.total,
  inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
  outputTokens: usage.output,
  reasoningTokens: usage.reasoning ?? 0,
  totalTokens: usage.totalTokens,
});

const emptyResourceLoader = (
  systemPrompt: string,
  createExtensionRuntime: () => ReturnType<
    typeof import("@earendil-works/pi-coding-agent")["createExtensionRuntime"]
  >
): ResourceLoader => ({
  extendResources: () => undefined,
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getAppendSystemPrompt: () => [],
  getExtensions: () => ({
    errors: [],
    extensions: [],
    runtime: createExtensionRuntime(),
  }),
  getPrompts: () => ({ diagnostics: [], prompts: [] }),
  getSkills: () => ({ diagnostics: [], skills: [] }),
  getSystemPrompt: () => systemPrompt,
  getThemes: () => ({ diagnostics: [], themes: [] }),
  reload: async () => undefined,
});

const customProviderId = (provider: PiProviderSpec["provider"]): string =>
  provider === "nanny" ? "loop-nanny" : "loop-au-pair";

export const piProviderId = (spec: PiProviderSpec): string =>
  spec.provider === "au-pair" && isOpenRouter(spec.endpoint)
    ? "openrouter"
    : customProviderId(spec.provider);

export const createPiSessionRuntime = async (
  spec: PiProviderSpec
): Promise<PiSessionRuntime> => {
  const [{ InMemoryCredentialStore }, { ModelRuntime }] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-coding-agent"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  if (spec.provider === "au-pair" && isOpenRouter(spec.endpoint)) {
    await modelRuntime.setRuntimeApiKey("openrouter", spec.apiKey ?? "", {
      allowNetwork: false,
    });
    const catalogModel = modelRuntime.getModel("openrouter", spec.model);
    if (!catalogModel) {
      throw new Error(`Pi does not know OpenRouter model ${spec.model}`);
    }
    const compat = catalogModel.compat as OpenAICompletionsCompat | undefined;
    const model = spec.providerSort
      ? {
          ...catalogModel,
          compat: {
            ...compat,
            openRouterRouting: {
              ...compat?.openRouterRouting,
              sort: spec.providerSort,
            },
          },
        }
      : catalogModel;
    return { model, modelRuntime, providerId: "openrouter" };
  }

  const providerId = piProviderId(spec);
  modelRuntime.registerProvider(providerId, {
    api: "openai-completions",
    baseUrl: normalizedBaseUrl(spec.endpoint),
    models: [
      {
        api: "openai-completions",
        compat: {
          maxTokensField: "max_tokens",
          requiresToolResultName: true,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
          supportsStrictMode: false,
          supportsUsageInStreaming: true,
          thinkingFormat: "qwen-chat-template",
        },
        contextWindow: spec.contextWindow ?? 131_072,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: spec.model,
        input: ["text"],
        maxTokens:
          spec.maxTokens ??
          (spec.provider === "nanny" ? NANNY_MAX_TOKENS : 32_768),
        name: spec.model,
        // Pi only emits qwen-chat-template controls for reasoning-capable
        // models. Nanny sessions select `off` below, which makes the actual
        // request carry chat_template_kwargs.enable_thinking=false instead of
        // leaving Qwen to its server-default thinking mode.
        reasoning: spec.provider === "nanny",
      },
    ],
    name: spec.provider === "nanny" ? "Loop Nanny" : "Loop Au Pair",
  });
  await modelRuntime.setRuntimeApiKey(
    providerId,
    spec.apiKey || LOCAL_DUMMY_KEY,
    { allowNetwork: false }
  );
  const model = modelRuntime.getModel(providerId, spec.model);
  if (!model) {
    throw new Error(`Pi did not register ${providerId}/${spec.model}`);
  }
  return { model, modelRuntime, providerId };
};

const assistantText = (content: readonly unknown[]): string =>
  content
    .flatMap((part) => {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }
      return [];
    })
    .join("");

export const completePiText = async (input: {
  maxTokens: number;
  provider: PiProviderSpec;
  signal?: AbortSignal;
  systemPrompt: string;
  temperature: number;
  timeoutMs: number;
  userPrompt: string;
}): Promise<PiTextCompletion> => {
  const runtime = await createPiSessionRuntime(input.provider);
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort();
  input.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const message = await runtime.modelRuntime.completeSimple(
      runtime.model,
      {
        messages: [
          { content: input.userPrompt, role: "user", timestamp: Date.now() },
        ],
        systemPrompt: input.systemPrompt,
      },
      {
        maxRetries: 0,
        maxTokens: input.maxTokens,
        signal: controller.signal,
        temperature: input.temperature,
        timeoutMs: input.timeoutMs,
      }
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(
        message.errorMessage || `Pi completion ${message.stopReason}`
      );
    }
    return {
      model: message.model,
      piVersion: PI_VERSION,
      provider: message.provider,
      stopReason: message.stopReason,
      text: assistantText(message.content),
      usage: normalizePiUsage(message.usage),
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
};

export const createEphemeralPiAgent = async (input: {
  cwd: string;
  provider: PiProviderSpec;
  systemPrompt: string;
  tools: ToolDefinition[];
}): Promise<{
  activeToolNames: string[];
  model: Model<Api>;
  providerId: string;
  session: AgentSession;
}> => {
  const {
    createAgentSession,
    createExtensionRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const runtime = await createPiSessionRuntime(input.provider);
  const toolNames = input.tools.map((tool) => tool.name);
  const { session } = await createAgentSession({
    cwd: input.cwd,
    customTools: input.tools,
    model: runtime.model,
    modelRuntime: runtime.modelRuntime,
    noTools: "builtin",
    resourceLoader: emptyResourceLoader(
      input.systemPrompt,
      createExtensionRuntime
    ),
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager: SettingsManager.inMemory(
      {
        compaction: { enabled: false },
        defaultProjectTrust: "never",
        enableAnalytics: false,
        enableInstallTelemetry: false,
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      },
      { projectTrusted: false }
    ),
    thinkingLevel: input.provider.provider === "nanny" ? "off" : "minimal",
    tools: toolNames,
  });
  return {
    activeToolNames: session.getActiveToolNames(),
    model: runtime.model,
    providerId: runtime.providerId,
    session,
  };
};
