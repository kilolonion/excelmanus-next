import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "@excelmanus/protocol";

// Load the browser module through Vite so DOM types do not leak into the Node server build.
interface BrowserSyncClient {
  subscribe(topic: string): void; start(): void; stop(): void;
  send(message: ClientMessage): boolean; readonly connected: boolean;
}
const { SyncClient } = await vi.importActual<{ SyncClient: new (options: {
  ticket(): Promise<string>; cursor(topic: string): number | undefined;
  onState(connected: boolean): void; onMessage(message: ServerMessage): void;
}) => BrowserSyncClient }>("../../web/src/lib/backend/sync.ts");
import { initialDocSync, latestDocConflict, markOffline, reduceDoc, trackDocSubmit, dropPending, markDisconnected } from "../../web/src/lib/workbook/doc-sync.js";

/** Real HTTP + TCP/WebSocket transport; no browser Offline emulation, no production server. */
test("socket loss retains offline edits, reacquires tickets and resumes cursors without automatic resubmission", async () => {
  let unavailable = false;
  let loseAck = false;
  let tickets = 0;
  let failedTickets = 0;
  const server = createServer((_req, res) => {
    if (unavailable) {
      failedTickets++;
      res.writeHead(503).end("offline");
    } else {
      tickets++;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ticket: "test-" + tickets }));
    }
  });
  const wss = new WebSocketServer({ server });
  const received: Array<Record<string, unknown>> = [];
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      received.push(msg);
      if (msg.type === "sub") ws.send(JSON.stringify({ type: "sub.ok", topic: msg.topic, cursor: msg.cursor, headCursor: msg.cursor }));
      if (msg.type === "doc.submit") {
        if (loseAck) ws.terminate();
        else ws.send(JSON.stringify({ type: "doc.ack", clientOpId: msg.clientOpId, rev: 10 }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const base = "http://127.0.0.1:" + address.port;
  vi.stubGlobal("window", { location: new URL(base) });
  let state = initialDocSync(7);
  const states: boolean[] = [];
  const client = new SyncClient({
    ticket: async () => {
      const response = await fetch(base + "/ticket");
      if (!response.ok) throw new Error("ticket unavailable");
      return ((await response.json()) as { ticket: string }).ticket;
    },
    cursor: () => state.rev,
    onState: (connected) => { states.push(connected); if (!connected) state = markDisconnected(state); },
    onMessage: (message) => { state = reduceDoc(state, message); },
  });
  const mutation = { id: "sheet.mutation.set-range-values", params: { subUnitId: "sheet1", cellValue: { 0: { 3: { v: "offline draft" } } } } };
  const submitted = { mutation, mutations: [mutation], baseRev: 7 };
  try {
    client.subscribe("doc:qa");
    client.start();
    await vi.waitFor(() => expect(received).toContainEqual({ type: "sub", topic: "doc:qa", cursor: 7 }));
    unavailable = true;
    for (const socket of wss.clients) socket.terminate();
    await vi.waitFor(() => expect(client.connected).toBe(false));
    state = trackDocSubmit(state, "offline-op", submitted);
    const sent = client.send({ type: "doc.submit", docId: "qa", clientOpId: "offline-op", baseRev: 7, mutations: [mutation] });
    expect(sent).toBe(false);
    if (!sent) state = markOffline(state, "offline-op", submitted);
    expect(latestDocConflict(state)?.submitted).toEqual(submitted);
    await vi.waitFor(() => expect(failedTickets).toBeGreaterThan(0), { timeout: 3000 });
    // The cursor may have advanced from a separately loaded authoritative snapshot.
    state = { ...state, rev: 9 };
    unavailable = false;
    await vi.waitFor(() => expect(connections).toBe(2), { timeout: 6000 });
    await vi.waitFor(() => expect(received).toContainEqual({ type: "sub", topic: "doc:qa", cursor: 9 }));
    expect(received.filter((msg) => msg.type === "doc.submit")).toHaveLength(0);
    expect(latestDocConflict(state)?.submitted).toEqual(submitted);
    state = trackDocSubmit(dropPending(state, "offline-op"), "explicit-retry", submitted);
    expect(client.send({ type: "doc.submit", docId: "qa", clientOpId: "explicit-retry", baseRev: 7, mutations: [mutation] })).toBe(true);
    await vi.waitFor(() => {
      expect(state.pending["explicit-retry"]).toBeUndefined();
      expect(state.rev).toBe(10);
    });
    expect(received.filter((msg) => msg.type === "doc.submit")).toHaveLength(1);
    expect(state.rev).toBe(10);
    expect(tickets).toBe(2);
    expect(states).toContain(false);
    expect(states.at(-1)).toBe(true);
    // A server-received operation whose acknowledgement is lost must not remain pending forever.
    loseAck = true;
    state = trackDocSubmit(state, "lost-ack", submitted);
    expect(client.send({ type: "doc.submit", docId: "qa", clientOpId: "lost-ack", baseRev: 7, mutations: [mutation] })).toBe(true);
    await vi.waitFor(() => expect(latestDocConflict(state)?.code).toBe("connection_lost"));
    expect(latestDocConflict(state)?.submitted).toEqual(submitted);
    await vi.waitFor(() => expect(connections).toBe(3), { timeout: 6000 });
    expect(received.filter((msg) => msg.type === "doc.submit")).toHaveLength(2);
    expect(latestDocConflict(state)?.code).toBe("connection_lost");
  } finally {
    client.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllGlobals();
  }
}, 12000);

