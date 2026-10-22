/**
 * A reply in the wrong script is caught at the end of the turn.
 *
 * Reported as the Chief of Staff bot greeting in English and then, three
 * bubbles later, briefing in Chinese: the same model, drifting after a
 * run of tool results. The check is by script, on the last user message
 * against every assistant text after it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dominantScript,
  replyLanguageMismatch,
  replyLanguagePrompt,
} from "./reply-language.js";
import {
  accountReplyLanguagePrompt,
  buildSetUserLanguageTool,
  learnUserLanguage,
  readUserLanguage,
  resolveReplyLanguage,
  writeUserLanguage,
} from "./user-language.js";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("dominantScript", () => {
  it("names the script most of the letters are in", () => {
    expect(dominantScript("Let me set up the daily routine for you now.")).toBe(
      "latin"
    );
    expect(
      dominantScript(
        "好了，Chief of Staff 已就位。我已在工作日安排你的每日简报"
      )
    ).toBe("cjk");
  });

  it("says nothing about a short text, or code", () => {
    expect(dominantScript("ok")).toBeNull();
    expect(
      dominantScript("```\nls -la /Users/me/.abacusai-bot/routines\n```")
    ).toBeNull();
  });
});

describe("replyLanguageMismatch", () => {
  it("flags a Chinese reply to an English message", () => {
    const mismatch = replyLanguageMismatch([
      user("Introduce yourself once, then get started on your mission."),
      assistant("I'm Chief of Staff. Let me get oriented."),
      { role: "toolResult", content: "ok" },
      assistant(
        "好了，Chief of Staff 已就位。我已在工作日的每个工作日早上安排你的每日简报——它会查看你的日历、Gmail 和 Slack。现在有什么要我做的吗？"
      ),
    ]);

    expect(mismatch).toEqual({ expected: "latin", got: "cjk" });
  });

  it("lets a reply in the user's own script through", () => {
    expect(
      replyLanguageMismatch([
        user("请用中文介绍一下你自己，然后开始执行你的任务。"),
        assistant("好的，我是你的幕僚长。我已经安排了每日简报，现在就开始。"),
      ])
    ).toBeNull();
    expect(
      replyLanguageMismatch([
        user("Introduce yourself once, then get started on your mission."),
        assistant(
          "I'm Chief of Staff. The routine is set for weekday mornings."
        ),
      ])
    ).toBeNull();
  });

  it("judges the last thing said, so English paragraphs ahead of the drift do not hide it", () => {
    expect(
      replyLanguageMismatch([
        user("Introduce yourself once, then get started on your mission."),
        assistant(
          "I'm Chief of Staff. Before I do anything else, let me set up my morning routine: a weekday morning briefing that reviews your calendar, Gmail, and Slack."
        ),
        { role: "toolResult", content: "ok" },
        assistant(
          "It's Monday 8:15 PM here in Asia/Calcutta. I'll set the routine to fire every weekday morning, and I'll kick off right now with a first pass."
        ),
        { role: "toolResult", content: "ok" },
        assistant(
          "好了，Chief of Staff 已就位。我已在工作日的每个工作日早上安排你的每日简报——它会查看你的日历、Gmail 和 Slack，并将结果分为三项返回。现在有什么要我做的吗？"
        ),
      ])
    ).toEqual({ expected: "latin", got: "cjk" });
  });

  it("flags a Chinese reply whose English technical terms outnumber the prose", () => {
    // The reply a user got to "is my github connected?": Chinese sentences
    // carrying GitHub, the account names, the scopes and "keyring token".
    // Han held under 60% of the letters, so dominance saw no clear script and
    // the repair never ran.
    expect(
      replyLanguageMismatch([
        user("is my github connected ?"),
        assistant(
          "是的——GitHub 已连接。✅\n\n" +
            "- **活跃账号:** `PranshuS007`（Pranshu Sharma），通过 token 认证\n" +
            "- **令牌权限范围:** `admin:org`、`project`、`repo`、`user`、`workflow`——因此私有仓库、PR 和 Issues 均可使用\n" +
            "- 你那里还有一个第二账号已登录但未激活: `pranshu-11`（keyring token）\n\n" +
            "所以 `gh` 和 git-over-HTTPS 已经可以使用了——直接告诉我你想在哪个仓库上做什么就行。"
        ),
      ])
    ).toEqual({ expected: "latin", got: "cjk" });
  });

  it("lets English terms through in a reply to a user who writes in another script", () => {
    // Identifiers, product names and error text are English in every
    // language's technical prose; a Chinese user gets them too.
    expect(
      replyLanguageMismatch([
        user("我的 GitHub 连接好了吗？"),
        assistant(
          "是的，GitHub 已连接。活跃账号是 PranshuS007，token 的权限范围包括 admin:org、repo、user 和 workflow，所以 gh 和 git over HTTPS 都可以直接使用。"
        ),
      ])
    ).toBeNull();
  });

  it("still flags a reply that drifted into Latin for a user who writes in another script", () => {
    expect(
      replyLanguageMismatch([
        user("请帮我看看今天的日程安排，然后告诉我有没有需要提前准备的会议。"),
        assistant(
          "You have three meetings today. The 3pm one references the Q3 deck, which needs a review before you join; the other two need nothing from you."
        ),
      ])
    ).toEqual({ expected: "cjk", got: "latin" });
  });

  it("judges a message as a whole, so a name in another script does not trip it", () => {
    expect(
      replyLanguageMismatch([
        user("Who messaged me on WhatsApp today, and what did they want?"),
        assistant(
          "Two people: 王伟 asked about the invoice, and Raj wants to move the standup to Thursday afternoon."
        ),
      ])
    ).toBeNull();
  });

  it("ignores the app's own reminder inside the user's turn", () => {
    expect(
      replyLanguageMismatch([
        user(
          "hola, ¿qué tengo hoy?\n\n<system_reminder>\nMessaging platforms connected (1): discord\n</system_reminder>"
        ),
        assistant(
          "Hoy tienes dos reuniones por la mañana y una llamada a las cuatro."
        ),
      ])
    ).toBeNull();
  });

  it("does not judge the app's tagged notes as the user's words", () => {
    const japanese =
      "こんにちは、太郎さん！今日の予定をお知らせします。午前十時に会議があります。";
    expect(
      replyLanguageMismatch([
        user(
          "[linked] The user just connected WhatsApp.\n\n[first brief] This is the user's first time here: open with a short brief."
        ),
        assistant(japanese),
      ])
    ).toBeNull();
    expect(
      replyLanguageMismatch([
        user(
          "[check-ins sent] Since the user's last message the app texted them: a reminder.\n\n今日の予定は？"
        ),
        assistant(japanese),
      ])
    ).toBeNull();
  });
});

describe("a short question", () => {
  const user = (content: string) => ({ role: "user", content });
  const assistant = (content: string) => ({ role: "assistant", content });
  const chinese =
    "项目概览。一个用 Python 构建的生产级短链服务，主要技术栈包括数据库、缓存和部署配置。目录结构如下，核心工作原理见下文。";

  it("is judged on its own letters when it is all the user has said", () => {
    expect(
      replyLanguageMismatch([user("whats in it ?"), assistant(chinese)])
    ).toEqual({ expected: "latin", got: "cjk" });
    expect(replyLanguageMismatch([user("hi"), assistant(chinese)])).toEqual({
      expected: "latin",
      got: "cjk",
    });
  });

  it("borrows the language of the turns before it", () => {
    expect(
      replyLanguageMismatch([
        user("请用中文介绍一下这个项目的目录结构和核心原理，谢谢。"),
        assistant(chinese),
        user("ok"),
        assistant(chinese),
      ])
    ).toBeNull();
  });
});

describe("the reply-language prompt line", () => {
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("follows the user's message, falls back to the resolved language, and names the Chinese leak", () => {
    expect(replyLanguagePrompt({ name: "Turkish", chosen: false })).toBe(
      [
        "## Reply language",
        "",
        "Reply in the language of the user's latest message, or in English when that is Hindi. " +
          'When it has no words to go by (a first run, a routine, a greeting like "ok", a link), ' +
          "reply in Turkish. Write the whole reply in that one language and its script: never " +
          "switch partway, and never mix in words or characters from another language (no " +
          "Chinese characters in a Turkish reply), whatever language the tool results, documents " +
          "or messages you read were in. Names, code and quoted text stay as they are.",
      ].join("\n")
    );
    for (const name of ["Brazilian Portuguese", "Spanish"])
      expect(flat(replyLanguagePrompt({ name, chosen: false }))).toContain(
        `reply in ${name}. Write the whole reply in that one language and its script: never switch partway, and never mix in words or characters from another language (no Chinese characters in a ${name} reply),`
      );
    expect(replyLanguagePrompt({ name: "English", chosen: false })).toContain(
      "(no Chinese characters in an English reply)"
    );
  });

  it("drops the Chinese clause when the fallback itself writes Han", () => {
    const japanese = replyLanguagePrompt({ name: "Japanese", chosen: false });
    expect(japanese).toContain("reply in Japanese.");
    expect(japanese).not.toMatch(/Chinese characters/);
    expect(japanese).toContain(
      "never mix in words or characters from another language, whatever language"
    );
  });

  it("puts a language the user chose ahead of their message", () => {
    const chosen = replyLanguagePrompt({ name: "Turkish", chosen: true });
    expect(chosen).toContain(
      "Reply in Turkish, the language the user chose for every reply, unless they ask for another language for a single reply."
    );
    expect(chosen).not.toContain("latest message");
    expect(chosen).toContain("(no Chinese characters in a Turkish reply)");
  });

  it("carries nothing per turn: the same language gives the same bytes", () => {
    const one = replyLanguagePrompt({ name: "Turkish", chosen: false });
    expect(replyLanguagePrompt({ name: "Turkish", chosen: false })).toBe(one);
    expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
  });
});

describe("which language replies fall back to", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "reply-language-"));
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    vi.stubEnv("ABACUSAI_BOT_LOCALE", "");
    vi.stubEnv("ABACUSAI_BOT_SENDER_CHAT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const chosen = { name: "Turkish", source: "user" } as const;
  const detected = { name: "Spanish", source: "detected" } as const;

  it.each([
    [
      "the user's choice over everything",
      chosen,
      "pt-BR",
      false,
      "Turkish",
      true,
    ],
    [
      "the detected language over the app's",
      detected,
      "pt-BR",
      false,
      "Spanish",
      false,
    ],
    [
      "the app's language with nothing saved",
      null,
      "pt-BR",
      false,
      "Brazilian Portuguese",
      false,
    ],
    ["a bare app tag", null, "tr", false, "Turkish", false],
    [
      "a regional tag the UI does not ship",
      null,
      "bn-BD",
      false,
      "Bangla",
      false,
    ],
    [
      "a regional tag reads as its language",
      null,
      "tr-TR",
      false,
      "Turkish",
      false,
    ],
    ["English with nothing at all", null, undefined, false, "English", false],
    [
      "English for a tag that names no language",
      null,
      "xx",
      false,
      "English",
      false,
    ],
    [
      "a sender's chat: the choice is only the fallback",
      chosen,
      "pt-BR",
      true,
      "Turkish",
      false,
    ],
  ] as const)(
    "resolves %s",
    (_label, saved, locale, sender, name, isChosen) => {
      expect(resolveReplyLanguage(saved, locale, sender)).toEqual({
        name,
        chosen: isChosen,
      });
    }
  );

  it("never resolves to Hindi, from any source", () => {
    const english = { name: "English", chosen: false };
    expect(resolveReplyLanguage(null, "hi-IN")).toEqual(english);
    expect(resolveReplyLanguage(null, "hi")).toEqual(english);
    expect(
      resolveReplyLanguage({ name: "Hindi", source: "detected" }, "tr-TR")
    ).toEqual(english);
    expect(
      resolveReplyLanguage({ name: "Hinglish", source: "detected" }, null)
    ).toEqual(english);
    expect(
      resolveReplyLanguage({ name: "hindi", source: "user" }, null)
    ).toEqual({
      name: "English",
      chosen: true,
    });

    // Saved as English, whether detected or asked for.
    writeUserLanguage("Hindi", "detected");
    expect(readUserLanguage()).toEqual({ name: "English", source: "detected" });
    vi.stubEnv("ABACUSAI_BOT_LOCALE", "hi-IN");
    fs.rmSync(path.join(home, "user-language.json"));
    expect(accountReplyLanguagePrompt()).toContain("reply in English.");
    expect(accountReplyLanguagePrompt()).not.toMatch(/reply in Hindi/);
  });

  it("saves set_user_language's Hindi as English, without a word about it", async () => {
    const result = await buildSetUserLanguageTool().execute("t1", {
      language: "Hindi",
    });
    expect(result.isError).toBeUndefined();
    expect(readUserLanguage()).toEqual({ name: "English", source: "user" });
    expect(result.content[0]?.text).not.toMatch(/Hindi/);
  });

  it("reads the app's language from ABACUSAI_BOT_LOCALE, and the saved one over it", () => {
    vi.stubEnv("ABACUSAI_BOT_LOCALE", "tr-TR");
    expect(accountReplyLanguagePrompt()).toContain("reply in Turkish.");
    writeUserLanguage("Spanish", "detected");
    expect(accountReplyLanguagePrompt()).toContain("reply in Spanish.");
    writeUserLanguage("German", "user");
    expect(accountReplyLanguagePrompt()).toContain(
      "Reply in German, the language the user chose"
    );
    vi.stubEnv("ABACUSAI_BOT_SENDER_CHAT", "1");
    expect(accountReplyLanguagePrompt()).toContain("latest message");
    expect(accountReplyLanguagePrompt()).toContain("reply in German.");
  });

  it("never learns the language from the app's own first-run note", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    await learnUserLanguage(
      "[first run] Introduce yourself once, then get started.",
      "key",
      fetchImpl as unknown as typeof fetch
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readUserLanguage()).toBeNull();
  });
});
