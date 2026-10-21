/**
 * The roster, checked without a session: every tool this process can
 * register has an off switch in the Capabilities registry and a pinned
 * permission decision. tool-roster.e2e.test.ts proves the same against a
 * running host; this catches the miss at the table, seconds after it is
 * made, with nothing to build.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TOOL_NAME_ALIASES } from "./excluded-tools.js";
import {
  buildRoster,
  NOT_SWITCHABLE,
  OWN_TOOLS,
  ROSTER_TOOL_NAMES,
  SUB_AGENT_TOOLS,
  subAgentOptions,
  type RosterContext,
} from "./roster.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const TOOLSETS = fs.readFileSync(
  path.join(REPO_ROOT, "packages", "contract", "src", "toolsets.ts"),
  "utf8"
);
const GATE_ROSTER = fs.readFileSync(
  path.join(HERE, "gate-roster.test.ts"),
  "utf8"
);

describe("the roster table", () => {
  it("names each tool once", () => {
    expect(new Set(ROSTER_TOOL_NAMES).size).toBe(ROSTER_TOOL_NAMES.length);
  });

  it("is switchable from the Capabilities pane, tool by tool", () => {
    // Through the same alias the exclude list uses: the registry says `glob`
    // where pi says `find`, and both halves already agree on that.
    const unswitchable = ROSTER_TOOL_NAMES.map(
      (tool) => TOOL_NAME_ALIASES[tool] ?? tool
    ).filter(
      (tool) =>
        !NOT_SWITCHABLE.includes(tool) &&
        !new RegExp(`['"]${tool}['"]`).test(TOOLSETS)
    );

    expect(unswitchable).toEqual([]);
  });

  it("has a pinned permission decision for every tool", () => {
    const unpinned = ROSTER_TOOL_NAMES.filter(
      (tool) =>
        !NOT_SWITCHABLE.includes(tool) &&
        !new RegExp(`name: ['"]${tool}['"]`).test(GATE_ROSTER)
    );

    expect(unpinned).toEqual([]);
  });

  it("keeps the not-switchable list to tools that are in the table", () => {
    for (const name of NOT_SWITCHABLE) {
      expect(ROSTER_TOOL_NAMES).toContain(name);
    }
  });
});

describe("building the roster", () => {
  const context = (provided: string[]): RosterContext =>
    ({
      cwd: "/tmp/roster-ws",
      agentDir: "/tmp/roster-agent",
      modelRuntime: {} as never,
      subAgentSettingsManager: {} as never,
      model: () => undefined,
      browserModel: () => undefined,
      hostServices: null,
      excluded: [],
      operations: {} as never,
      mcp: () => ({ tools: [], clients: [], statuses: [] }) as never,
      provided: new Set(provided),
      mode: () => "normal" as never,
      sessionId: () => undefined,
      emit: () => undefined,
      reloadSkills: () => undefined,
    }) as RosterContext;

  it("registers a tool nothing else provides, and skips one something does", () => {
    const names = (roster: { tools: { name: string }[] }): string[] =>
      roster.tools.map((tool) => tool.name);

    const bare = names(buildRoster(context([]), () => false));
    expect(bare).toEqual(expect.arrayContaining(["todo", "memory", "serve"]));

    const served = names(buildRoster(context(["todo", "memory"]), () => false));
    expect(served).not.toContain("todo");
    expect(served).not.toContain("memory");
    expect(served).toContain("serve");
  });

  it("keeps the always-on tools whatever is provided", () => {
    const roster = buildRoster(
      context([...OWN_TOOLS, ...SUB_AGENT_TOOLS].map((e) => e.name)),
      () => false
    );
    const names = roster.tools.map((tool) => tool.name);

    for (const name of NOT_SWITCHABLE) expect(names).toContain(name);
    expect(names).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
  });

  it("withholds nothing behind a host service when there is none", () => {
    const names = buildRoster(context([]), () => false).tools.map(
      (tool) => tool.name
    );

    for (const name of ["document", "design", "ppt"]) {
      expect(names).not.toContain(name);
    }
  });
});

describe("the roster's read", () => {
  const DOCS = path.join(HERE, "__fixtures__", "documents");
  const read = (filePath: string): Promise<string> =>
    (
      OWN_TOOLS.find((entry) => entry.name === "read")!.build({
        cwd: DOCS,
      } as RosterContext) as unknown as {
        execute: (
          id: string,
          params: { path: string }
        ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
      }
    )
      .execute("call", { path: filePath })
      .then((result) => result.content.map((part) => part.text ?? "").join(""));

  const scratch = (name: string, bytes: Uint8Array): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-read-"));
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };

  it("reads a PDF as its text, page by page, with no Python", async () => {
    const text = await read("brief.pdf");

    expect(text).toContain("[PDF, 2 pages]");
    expect(text).toContain("--- Page 1 ---\nCampaign brief");
    expect(text).toContain("--- Page 2 ---\nSecond page: budget");
  });

  it("says a PDF with no text layer is a scan instead of returning bytes", async () => {
    expect(await read("scan.pdf")).toMatch(
      /^\[PDF, 1 page, with no text layer/
    );
  });

  it("reads a Word document as its text", async () => {
    const text = await read("notes.docx");

    expect(text).toContain("Conhecimento do agente");
    expect(text).toContain("Posicionamento e direção criativa.");
    expect(text).toContain("Barbearia");
    expect(text).not.toContain("PK");
  });

  it("names any other binary file instead of dumping it", async () => {
    const zip = scratch(
      "kit.zip",
      Buffer.from("PK\u0003\u0004\u0000\u0000rest")
    );
    const blob = scratch("tool.exe", Buffer.from([0x4d, 0x5a, 0, 0, 1, 2]));

    expect(await read(zip)).toMatch(/kit\.zip is a zip archive .*unzip/);
    expect(await read(blob)).toMatch(/tool\.exe is a binary file/);
  });

  it("reads UTF-16 text the way Windows tools write it", async () => {
    const file = scratch(
      "out.txt",
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("olá\n", "utf16le"),
      ])
    );

    expect(await read(file)).toBe("olá\n");
  });

  it("still reads plain text as it is", async () => {
    expect(await read(scratch("a.md", Buffer.from("# Title\nbody")))).toBe(
      "# Title\nbody"
    );
  });
});

describe("a sub-agent's model", () => {
  it("is the session's model at spawn, not at build", () => {
    // The reported case: a session opened on the pool's first pick, the user
    // switched to a free model, and a document sub-agent still ran, and
    // billed, on the model the table was built with.
    let current: unknown = "abacus/pool-pick";
    const options = subAgentOptions(
      {
        cwd: "/tmp/roster-ws",
        agentDir: "/tmp/roster-agent",
        modelRuntime: {} as never,
        subAgentSettingsManager: {} as never,
        model: () => current,
      },
      { hostServices: null }
    );

    expect(options.model).toBe("abacus/pool-pick");
    expect(options.hostServices).toBeNull();

    current = "abacus/stealth/union-alpha";

    expect(options.model).toBe("abacus/stealth/union-alpha");
  });
});
