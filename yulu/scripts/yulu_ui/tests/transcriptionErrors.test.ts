import { describe, expect, it } from "vitest";
import { AgentUnavailableError } from "../src/agentGateway.js";
import { transcriptionFailureReason } from "../src/transcriptionErrors.js";

describe("transcription failure categories", () => {
  it.each([
    [new TypeError("fetch failed", { cause: Object.assign(new Error("TLS connection reset"), { code: "ECONNRESET" }) }), "network"],
    [Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" }), "network"],
    [new TypeError("fetch failed", { cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }) }), "secure_connection"],
    [new TypeError("fetch failed", { cause: Object.assign(new Error("connection timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }), "timeout"],
    [new Error("realtime transcription deadline exceeded"), "timeout"],
    [new Error("xAI transcription failed (401): unauthorized"), "credentials"],
    [new Error("xAI OAuth 已失效，请在 Yulu 设置中重新授权"), "credentials"],
    [new Error("已选择 xAI API Key，但尚未设置"), "credentials"],
    [new Error("Unexpected server response: 403"), "permission"],
    [new Error("当前 xAI 账号没有 API 或音频转写权限，重新授权不会改变账号权限"), "permission"],
    [new Error("xAI transcription failed (429): too many requests"), "rate_limit"],
    [new Error("xAI transcription failed (503): unavailable"), "service"],
    [new Error("xAI transcription failed (503): upstream fetch failed"), "service"],
    [new Error("xAI transcription failed (401): token verification timeout"), "credentials"],
    [new Error("xAI transcription failed (400): fetch failed"), "unknown"],
    [new Error("xAI OAuth 刷新失败（HTTP 502）"), "service"],
    [new Error("xAI audio processing requires current Cloud Transcription Consent (v1)"), "configuration"],
    [new Error("本地转写模型尚未安装"), "configuration"],
    [new Error("audio_engine_unavailable HTTP 503"), "unknown"],
    [new Error("ffmpeg exited with code 1"), "unknown"],
    [new TypeError("Cannot read properties of undefined"), "unknown"],
    [new Error("xAI returned an empty transcript"), "unknown"],
  ])("classifies %s as %s without blaming all failures on the network", (error, reason) => {
    expect(transcriptionFailureReason(error)).toBe(reason);
  });

  it("handles a wrapped aggregate connection error and cyclic causes", () => {
    const cause = Object.assign(new Error("unreachable"), { code: "ENETUNREACH" });
    const error = new AgentUnavailableError("engine unavailable", { cause: new AggregateError([cause]) });
    cause.cause = error;
    expect(transcriptionFailureReason(error)).toBe("network");
  });
});
