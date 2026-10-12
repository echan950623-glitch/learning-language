import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { getStudyProfile, previewPracticeBatch, addPracticeBatch, previewCoachReport, saveCoachReport } from "./japanesePractice";
import { previewPracticeStatus, setPracticeStatus } from "./practiceStatus";

describe("practice MCP schemas through the actual SDK transport", () => {
  it("lists and calls every new tool without corrupting dynamic output fields", async () => {
    const server = new McpServer({ name: "schema-regression", version: "1" });
    const client = new Client({ name: "test-client", version: "1" });
    const tools = [getStudyProfile, previewPracticeBatch, addPracticeBatch, previewCoachReport, saveCoachReport, previewPracticeStatus, setPracticeStatus];
    // These callbacks deliberately perform no DB operations: this tests the wire contract.
    for (const tool of tools) server.registerTool(tool.name, { ...tool, inputSchema: tool.inputSchema as z.ZodObject }, async () => ({
      structuredContent: { tool: tool.name, ready: [{ title: "て形" }], duplicates: [], errors: [] },
      content: [{ type: "text", text: "valid" }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(7);
      expect(listed.tools.every(tool => tool.outputSchema?.type === "object")).toBe(true);
      const report = { externalId: "report-test", practicedAt: "2026-10-08T00:00:00.000Z", summary: "基礎練習", observations: [] };
      const cases = [
        { name: getStudyProfile.name, arguments: { offset: 0, limit: 1 } },
        { name: previewPracticeBatch.name, arguments: { items: [{ catalogId: "form:te:production", learnedConfirmed: true }] } },
        { name: addPracticeBatch.name, arguments: { confirm: true, items: [{ catalogId: "form:te:production", learnedConfirmed: true }] } },
        { name: previewCoachReport.name, arguments: report },
        { name: saveCoachReport.name, arguments: { ...report, confirm: true } },
        { name: previewPracticeStatus.name, arguments: { itemId: "item-test", learned: true, enabled: true } },
        { name: setPracticeStatus.name, arguments: { itemId: "item-test", learned: true, enabled: true, expectedContentVersion: 1, confirm: true } },
      ];
      for (const request of cases) {
        const result = await client.callTool(request);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ tool: request.name, ready: [{ title: "て形" }], duplicates: [], errors: [] });
      }
      const unconfirmed = await client.callTool({ name: addPracticeBatch.name, arguments: { items: [{ catalogId: "form:te:production" }] } });
      expect(unconfirmed.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
