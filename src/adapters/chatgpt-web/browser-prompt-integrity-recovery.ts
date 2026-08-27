import { ChatGptBrowserWorker } from "./browser-worker";

const PROMPT_INTEGRITY_RECOVERY_PATCH = Symbol.for(
  "codex-chatgpt-web.browser-prompt-integrity-recovery",
);

/**
 * ChatGPT's Lexical composer can occasionally discard the whole accumulated document while a
 * large prompt is being inserted in verified chunks. The browser worker already owns a guarded
 * one-shot attachment retry path: it checks for user/assistant/generation evidence before and
 * after clearing the composer, and refuses to retry if Send may have crossed the boundary.
 *
 * Upstream currently enables that guarded retry only for compaction turns. Enable the same retry
 * for every prompt-attachment integrity failure so a pre-Send Lexical reset does not tear down the
 * response stream. This deliberately does not retry arbitrary browser failures and does not add a
 * second retry after the guarded attempt is consumed.
 */
export function installChatGptPromptIntegrityRecovery(): void {
  const prototype = ChatGptBrowserWorker.prototype as unknown as Record<PropertyKey, unknown>;
  if (prototype[PROMPT_INTEGRITY_RECOVERY_PATCH] === true) return;

  const original = prototype.attachPromptWithCompactionRetry;
  if (typeof original !== "function") {
    throw new Error("ChatGPT browser worker prompt-integrity retry hook is unavailable");
  }

  prototype.attachPromptWithCompactionRetry = function patchedPromptAttachmentRetry(
    this: ChatGptBrowserWorker,
    ...args: unknown[]
  ): unknown {
    if (args.length < 4) {
      return Reflect.apply(original, this, args);
    }
    const guardedRetryArgs = [...args];
    // Argument 4 is the existing `compaction` retry gate. The underlying implementation still
    // performs its submission-evidence checks before clearing or reinserting anything.
    guardedRetryArgs[3] = true;
    return Reflect.apply(original, this, guardedRetryArgs);
  };

  Object.defineProperty(prototype, PROMPT_INTEGRITY_RECOVERY_PATCH, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
}

installChatGptPromptIntegrityRecovery();
