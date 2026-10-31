import { LIMITS } from "./config.js";
import { AppError } from "./errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "./http.js";
import { isRecord } from "./util.js";

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmToolCallPayload {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: LlmToolCallPayload[];
  tool_call_id?: string;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason: string;
}

export interface LlmClient {
  complete(messages: LlmMessage[], tools?: unknown[]): Promise<LlmResponse>;
}

export interface LlmClientDeps {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
}

/** OpenAI-compatible chat-completions client (works with DeepSeek, OpenAI, and similar). */
export function createLlmClient(deps: LlmClientDeps): LlmClient {
  const endpoint = `${deps.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async complete(messages: LlmMessage[], tools?: unknown[]): Promise<LlmResponse> {
      const body: Record<string, unknown> = {
        model: deps.model,
        messages,
        temperature: 0,
        max_tokens: 2000,
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = "auto";
      }

      const res = await fetchWithRetry(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deps.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        },
        {
          fetchImpl: deps.fetchImpl,
          timeoutMs: deps.timeoutMs ?? LIMITS.llmTimeoutMs,
          maxRetries: 1,
          retryDelayMs: deps.retryDelayMs,
        },
      );

      assertUpstreamOk(res, "LLM provider");
      const payload = await readJsonBody(res, "LLM provider");
      if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
        throw new AppError("E_PROVIDER", "LLM provider returned an unexpected response");
      }

      const choice = payload.choices[0];
      const message = isRecord(choice.message) ? choice.message : {};
      const content = typeof message.content === "string" ? message.content : "";

      const toolCalls: LlmToolCall[] = [];
      if (Array.isArray(message.tool_calls)) {
        for (const raw of message.tool_calls) {
          if (!isRecord(raw) || !isRecord(raw.function)) continue;
          if (typeof raw.function.name !== "string") continue;
          toolCalls.push({
            id: typeof raw.id === "string" ? raw.id : `call_${toolCalls.length}`,
            name: raw.function.name,
            arguments: typeof raw.function.arguments === "string" ? raw.function.arguments : "",
          });
        }
      }

      return {
        content,
        toolCalls,
        finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "",
      };
    },
  };
}
